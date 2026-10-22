import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { discoverRepos, parseWorktreeList } from "./repo-discovery.js";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, stdio: "pipe" }).toString().trim();
}

function initRepo(dir: string): void {
  mkdirSync(dir, { recursive: true });
  git(dir, "init", "-b", "main");
  git(dir, "config", "user.email", "test@test.com");
  git(dir, "config", "user.name", "Test");
  git(dir, "config", "commit.gpgsign", "false");
  writeFileSync(path.join(dir, "README.md"), `# ${path.basename(dir)}\n`);
  git(dir, "add", "README.md");
  git(dir, "commit", "-m", "initial");
}

/**
 * Mirrors the shape of a real mixed project folder:
 *
 * root/                      git repo itself (mostly untracked content)
 *   fork/                    clone of origin.git, main checkout
 *   fork-build/              external worktree of fork, created with `git worktree add`
 *   upstream/                second clone of the same origin.git
 *   plugins/pstack/          nested two levels deep
 *   vendor/sub/              `.git` file (submodule-style), not a repo of its own
 *   node_modules/dep/        ignored by name
 *   data/worktrees/h/slug/   managed worktree folder, excluded by root
 *   tmp/scratch/             ignored by default name
 */
describe("discoverRepos", () => {
  let base: string;
  let root: string;
  let origin: string;

  beforeAll(() => {
    base = realpathSync(mkdtempSync(path.join(tmpdir(), "repo-discovery-")));
    root = path.join(base, "root");
    origin = path.join(base, "origin.git");

    initRepo(root);
    const seed = path.join(base, "seed");
    initRepo(seed);
    git(base, "clone", "--bare", "--quiet", seed, origin);

    git(root, "clone", "--quiet", origin, "fork");
    git(
      path.join(root, "fork"),
      "worktree",
      "add",
      "--quiet",
      "-b",
      "build",
      path.join(root, "fork-build"),
    );
    git(root, "clone", "--quiet", origin, "upstream");
    initRepo(path.join(root, "plugins", "pstack"));

    mkdirSync(path.join(root, "vendor", "sub"), { recursive: true });
    writeFileSync(path.join(root, "vendor", "sub", ".git"), "gitdir: ../../.git/modules/sub\n");
    initRepo(path.join(root, "node_modules", "dep"));
    initRepo(path.join(root, "data", "worktrees", "h", "slug"));
    initRepo(path.join(root, "tmp", "scratch"));
  });

  afterAll(() => {
    rmSync(base, { recursive: true, force: true });
  });

  it("finds every independent repository and nothing else", async () => {
    const result = await discoverRepos({
      rootPath: root,
      excludeRoots: [path.join(root, "data", "worktrees")],
    });
    expect(result.repos.map((repo) => repo.relPath)).toEqual([
      ".",
      "fork",
      "plugins/pstack",
      "upstream",
    ]);
  });

  it("keeps two clones of one remote as separate repositories", async () => {
    const { repos } = await discoverRepos({ rootPath: root });
    const fork = repos.find((repo) => repo.relPath === "fork");
    const upstream = repos.find((repo) => repo.relPath === "upstream");
    expect(fork?.commonDir).not.toEqual(upstream?.commonDir);
    expect(fork?.commonDirHash).not.toEqual(upstream?.commonDirHash);
  });

  it("reports an externally created worktree through its main checkout", async () => {
    const { repos } = await discoverRepos({ rootPath: root });
    const fork = repos.find((repo) => repo.relPath === "fork");
    expect(
      fork?.checkouts.map((checkout) => [
        path.basename(checkout.path),
        checkout.branch,
        checkout.isMain,
        checkout.insideProject,
      ]),
    ).toEqual([
      ["fork", "main", true, true],
      ["fork-build", "build", false, true],
    ]);
    expect(repos.some((repo) => repo.relPath === "fork-build")).toBe(false);
  });

  it("treats the project root's own repository as an ordinary repo", async () => {
    const { repos } = await discoverRepos({ rootPath: root });
    const self = repos.find((repo) => repo.relPath === ".");
    expect(self?.rootPath).toBe(root);
    expect(self?.checkouts).toHaveLength(1);
  });

  it("includes pinned repositories beyond the ignore list", async () => {
    const { repos } = await discoverRepos({ rootPath: root, pinnedRelPaths: ["tmp/scratch"] });
    expect(repos.map((repo) => repo.relPath)).toContain("tmp/scratch");
  });

  it("respects maxDepth", async () => {
    const { repos } = await discoverRepos({ rootPath: root, maxDepth: 1 });
    expect(repos.map((repo) => repo.relPath)).toEqual([".", "fork", "upstream"]);
  });
});

describe("parseWorktreeList", () => {
  it("parses main, linked, detached and bare entries", () => {
    const stdout = [
      "worktree /p/repo",
      "HEAD aaaa",
      "branch refs/heads/main",
      "",
      "worktree /p/repo.wt/feature",
      "HEAD bbbb",
      "branch refs/heads/feature",
      "",
      "worktree /elsewhere/detached",
      "HEAD cccc",
      "detached",
      "",
      "worktree /p/bare.git",
      "bare",
      "",
    ].join("\n");
    expect(parseWorktreeList(stdout, "/p")).toEqual([
      {
        path: "/p/repo",
        branch: "main",
        head: "aaaa",
        isMain: true,
        detached: false,
        bare: false,
        insideProject: true,
      },
      {
        path: "/p/repo.wt/feature",
        branch: "feature",
        head: "bbbb",
        isMain: false,
        detached: false,
        bare: false,
        insideProject: true,
      },
      {
        path: "/elsewhere/detached",
        branch: null,
        head: "cccc",
        isMain: false,
        detached: true,
        bare: false,
        insideProject: false,
      },
      {
        path: "/p/bare.git",
        branch: null,
        head: null,
        isMain: false,
        detached: false,
        bare: true,
        insideProject: true,
      },
    ]);
  });
});
