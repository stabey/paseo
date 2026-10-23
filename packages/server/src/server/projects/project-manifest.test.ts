import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type { ProjectRepoPayload } from "@getpaseo/protocol/messages";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildProjectManifest } from "./project-manifest.js";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, stdio: "pipe" }).toString();
}

function initRepo(dir: string): void {
  mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "test@test.com");
  git(dir, "config", "user.name", "Test");
  git(dir, "config", "commit.gpgsign", "false");
  writeFileSync(path.join(dir, "README.md"), "one\ntwo\n");
  git(dir, "add", "README.md");
  git(dir, "commit", "-q", "-m", "initial commit");
}

function repoPayload(
  overrides: Partial<ProjectRepoPayload> & Pick<ProjectRepoPayload, "relPath" | "rootPath">,
): ProjectRepoPayload {
  return {
    commonDirHash: "hash",
    role: "normal",
    pinned: false,
    worktreeLocation: null,
    checkouts: [
      {
        path: overrides.rootPath,
        branch: "main",
        head: null,
        isMain: true,
        detached: false,
        bare: false,
        insideProject: true,
        managed: true,
      },
    ],
    ...overrides,
  };
}

describe("buildProjectManifest", () => {
  let base: string;
  let app: string;
  let docs: string;

  beforeAll(() => {
    base = realpathSync(mkdtempSync(path.join(tmpdir(), "project-manifest-")));
    app = path.join(base, "app");
    docs = path.join(base, "docs");
    initRepo(app);
    initRepo(docs);
    writeFileSync(path.join(app, "README.md"), "one\nchanged\nthree\n");
    writeFileSync(path.join(app, "notes.txt"), "untracked\n");
  });

  afterAll(() => {
    rmSync(base, { recursive: true, force: true });
  });

  it("reports the last commit and uncommitted changes per checkout and skips hidden repos", async () => {
    const manifest = await buildProjectManifest({
      projectId: "prj_manifest",
      rootPath: base,
      now: () => new Date("2026-10-23T00:00:00.000Z"),
      repos: [
        repoPayload({ relPath: "app", rootPath: app }),
        repoPayload({ relPath: "docs", rootPath: docs, role: "reference" }),
        repoPayload({ relPath: "vendor", rootPath: path.join(base, "vendor"), role: "hidden" }),
      ],
    });

    expect(manifest.generatedAt).toBe("2026-10-23T00:00:00.000Z");
    expect(manifest.repos.map((repo) => [repo.relPath, repo.role])).toEqual([
      ["app", "normal"],
      ["docs", "reference"],
    ]);
    const appCheckout = manifest.repos[0]!.checkouts[0]!;
    expect(appCheckout.lastCommit).toMatchObject({ subject: "initial commit" });
    expect(appCheckout.lastCommit?.sha).toBe(git(app, "rev-parse", "HEAD").trim());
    expect(appCheckout.uncommitted).toEqual({ files: 2, insertions: 2, deletions: 1 });
    expect(manifest.repos[1]!.checkouts[0]!.uncommitted).toEqual({
      files: 0,
      insertions: 0,
      deletions: 0,
    });
  });

  it("reports null git facts for a checkout git cannot read", async () => {
    const missing = path.join(base, "gone");
    const manifest = await buildProjectManifest({
      projectId: "prj_manifest",
      rootPath: base,
      repos: [repoPayload({ relPath: "gone", rootPath: missing })],
    });
    expect(manifest.repos[0]!.checkouts[0]).toMatchObject({ lastCommit: null, uncommitted: null });
  });
});
