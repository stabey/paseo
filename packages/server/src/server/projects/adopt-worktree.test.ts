import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import pino from "pino";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { isPaseoOwnedWorktreeCwd } from "../../utils/worktree.js";
import { readPaseoWorktreePlacement } from "../../utils/worktree-metadata.js";
import { FileBackedProjectRegistry, createPersistedProjectRecord } from "../workspace-registry.js";
import { adoptWorktree } from "./adopt-worktree.js";

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "pipe" });
}

describe("adoptWorktree", () => {
  let base: string;
  let projectRoot: string;
  let registry: FileBackedProjectRegistry;
  const deps = {
    get projectRegistry() {
      return registry;
    },
    resolveDefaultBranch: async () => "main",
  };

  beforeAll(async () => {
    base = realpathSync.native(mkdtempSync(path.join(tmpdir(), "adopt-worktree-")));
    projectRoot = path.join(base, "project");
    const repo = path.join(projectRoot, "app");
    mkdirSync(repo, { recursive: true });
    git(repo, "init", "-b", "main");
    git(repo, "config", "user.email", "t@t");
    git(repo, "config", "user.name", "t");
    git(repo, "config", "commit.gpgsign", "false");
    writeFileSync(path.join(repo, "a.txt"), "a\n");
    git(repo, "add", "a.txt");
    git(repo, "commit", "-m", "init");
    git(repo, "worktree", "add", "--quiet", "-b", "feature", path.join(base, "feature-wt"));

    registry = new FileBackedProjectRegistry(
      path.join(base, "projects.json"),
      pino({ level: "silent" }),
    );
    await registry.upsert(
      createPersistedProjectRecord({
        projectId: "prj_adopt",
        rootPath: projectRoot,
        kind: "non_git",
        displayName: "project",
        createdAt: "2026-10-22T00:00:00.000Z",
        updatedAt: "2026-10-22T00:00:00.000Z",
      }),
    );
  });

  afterAll(() => {
    rmSync(base, { recursive: true, force: true });
  });

  it("marks a plain git worktree as Paseo-owned and records it on the project", async () => {
    const worktreePath = path.join(base, "feature-wt");
    const paseoHome = path.join(base, "home");
    expect((await isPaseoOwnedWorktreeCwd(worktreePath, { paseoHome })).allowed).toBe(false);

    const project = await adoptWorktree(deps, {
      projectId: "prj_adopt",
      relPath: "app",
      worktreePath,
    });

    expect(project.repos.find((repo) => repo.relPath === "app")?.adoptedWorktrees).toEqual([
      worktreePath,
    ]);
    expect(readPaseoWorktreePlacement(worktreePath)).toEqual({ worktreesRoot: base });
    await expect(
      isPaseoOwnedWorktreeCwd(path.join(worktreePath, "nested"), { paseoHome }),
    ).resolves.toMatchObject({ allowed: true, worktreeRoot: base, worktreePath });
  });

  // Windows short temp paths and symlinks both name the folder differently from git's listing.
  it("adopts a worktree named through a link to it", async () => {
    const repo = path.join(projectRoot, "app");
    git(repo, "worktree", "add", "--quiet", "-b", "linked", path.join(base, "linked-wt"));
    const linkedPath = path.join(base, "link-to-linked-wt");
    symlinkSync(
      path.join(base, "linked-wt"),
      linkedPath,
      process.platform === "win32" ? "junction" : "dir",
    );

    const project = await adoptWorktree(deps, {
      projectId: "prj_adopt",
      relPath: "app",
      worktreePath: linkedPath,
    });

    expect(project.repos.find((entry) => entry.relPath === "app")?.adoptedWorktrees).toContain(
      linkedPath,
    );
  });

  it("refuses the main checkout and paths that are not checkouts of the repository", async () => {
    await expect(
      adoptWorktree(deps, {
        projectId: "prj_adopt",
        relPath: "app",
        worktreePath: path.join(projectRoot, "app"),
      }),
    ).rejects.toMatchObject({ code: "not_a_linked_checkout" });
    await expect(
      adoptWorktree(deps, { projectId: "prj_adopt", relPath: "app", worktreePath: base }),
    ).rejects.toMatchObject({ code: "not_a_linked_checkout" });
    await expect(
      adoptWorktree(deps, { projectId: "prj_adopt", relPath: "missing", worktreePath: base }),
    ).rejects.toMatchObject({ code: "repo_not_found" });
  });
});
