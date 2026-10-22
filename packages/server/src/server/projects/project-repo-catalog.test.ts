import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import pino from "pino";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  FileBackedProjectRegistry,
  createPersistedProjectRecord,
  type PersistedProjectRecord,
} from "../workspace-registry.js";
import { ProjectRepoCatalog } from "./project-repo-catalog.js";
import { discoverRepos } from "./repo-discovery.js";

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "pipe" });
}

function initRepo(dir: string): void {
  mkdirSync(dir, { recursive: true });
  git(dir, "init", "-b", "main");
  git(dir, "config", "user.email", "test@test.com");
  git(dir, "config", "user.name", "Test");
  git(dir, "config", "commit.gpgsign", "false");
  writeFileSync(path.join(dir, "README.md"), "# repo\n");
  git(dir, "add", "README.md");
  git(dir, "commit", "-m", "initial");
}

function adoptWorktree(
  record: PersistedProjectRecord,
  worktreePath: string,
): PersistedProjectRecord {
  return {
    ...record,
    repos: record.repos.map((repo) => ({ ...repo, adoptedWorktrees: [worktreePath] })),
  };
}

describe("ProjectRepoCatalog", () => {
  const logger = pino({ level: "silent" });
  let base: string;
  let paseoHome: string;
  let projectRoot: string;
  let registry: FileBackedProjectRegistry;
  let project: PersistedProjectRecord;

  beforeAll(async () => {
    base = realpathSync(mkdtempSync(path.join(tmpdir(), "repo-catalog-")));
    paseoHome = path.join(base, "home");
    projectRoot = path.join(base, "project");
    mkdirSync(paseoHome, { recursive: true });
    initRepo(path.join(projectRoot, "app"));
    // Sibling worktree folder created outside Paseo, and one in an unrelated place.
    git(
      path.join(projectRoot, "app"),
      "worktree",
      "add",
      "--quiet",
      "-b",
      "wt-a",
      path.join(projectRoot, "app.wt", "a"),
    );
    git(
      path.join(projectRoot, "app"),
      "worktree",
      "add",
      "--quiet",
      "-b",
      "wt-b",
      path.join(base, "elsewhere-b"),
    );
    initRepo(path.join(projectRoot, "docs-site"));

    registry = new FileBackedProjectRegistry(path.join(paseoHome, "projects.json"), logger);
    project = createPersistedProjectRecord({
      projectId: "prj_catalog",
      rootPath: projectRoot,
      kind: "non_git",
      displayName: "project",
      createdAt: "2026-10-22T00:00:00.000Z",
      updatedAt: "2026-10-22T00:00:00.000Z",
    });
    await registry.upsert(project);
  });

  afterAll(() => {
    rmSync(base, { recursive: true, force: true });
  });

  it("scans registered projects on start and persists the result", async () => {
    const changed: string[] = [];
    const catalog = new ProjectRepoCatalog({
      paseoHome,
      projectRegistry: registry,
      logger,
      onChanged: (record) => changed.push(record.projectId),
    });
    await catalog.start();
    const snapshot = await catalog.refresh(project);
    catalog.dispose();

    expect(snapshot.repos.map((repo) => repo.relPath)).toEqual(["app", "docs-site"]);
    expect(changed).toContain("prj_catalog");
    expect(existsSync(path.join(paseoHome, "projects", "prj_catalog.json"))).toBe(true);
  });

  it("marks main and adopted checkouts as managed and plain git worktrees as external", async () => {
    await registry.update("prj_catalog", (record) => ({
      ...record,
      repos: [
        {
          relPath: "app",
          commonDirHash: null,
          role: "normal",
          pinned: false,
          worktreeLocation: "sibling",
          adoptedWorktrees: [],
        },
      ],
    }));
    const catalog = new ProjectRepoCatalog({ paseoHome, projectRegistry: registry, logger });
    await catalog.start();
    const current = (await registry.get("prj_catalog"))!;
    const before = (await catalog.refresh(current)).repos.find((repo) => repo.relPath === "app")!;
    expect(before.worktreeLocation).toBe("sibling");
    const managedByBranch = before.checkouts
      .map((checkout) => [checkout.branch, checkout.managed] as const)
      .sort((left, right) => String(left[0]).localeCompare(String(right[0])));
    expect(managedByBranch).toEqual([
      ["main", true],
      ["wt-a", false],
      ["wt-b", false],
    ]);

    await registry.update("prj_catalog", (record) =>
      adoptWorktree(record, path.join(base, "elsewhere-b")),
    );
    const adopted = catalog
      .snapshot((await registry.get("prj_catalog"))!)!
      .repos.find((repo) => repo.relPath === "app")!;
    expect(adopted.checkouts.find((checkout) => checkout.branch === "wt-b")?.managed).toBe(true);
    catalog.dispose();
  });

  it("serves the persisted cache before rescanning and applies role settings", async () => {
    let scans = 0;
    const catalog = new ProjectRepoCatalog({
      paseoHome,
      projectRegistry: registry,
      logger,
      discover: async (options) => {
        scans += 1;
        return discoverRepos(options);
      },
    });
    await catalog.start();
    const current = (await registry.get("prj_catalog"))!;
    expect(scans).toBe(0);
    expect(catalog.snapshot(current)?.repos.map((repo) => repo.relPath)).toEqual([
      "app",
      "docs-site",
    ]);

    await registry.update("prj_catalog", (record) => ({
      ...record,
      repos: [
        ...record.repos,
        {
          relPath: "docs-site",
          commonDirHash: null,
          role: "reference",
          pinned: false,
          worktreeLocation: null,
          adoptedWorktrees: [],
        },
      ],
    }));
    const withRole = catalog.snapshot((await registry.get("prj_catalog"))!)!;
    expect(withRole.repos.find((repo) => repo.relPath === "docs-site")?.role).toBe("reference");
    catalog.dispose();
  });
});
