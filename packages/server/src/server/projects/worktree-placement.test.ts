import path from "node:path";

import { describe, expect, it } from "vitest";

import { createPersistedProjectRecord } from "../workspace-registry.js";
import {
  assertWorktreeSourceInProject,
  repoRelPath,
  resolveWorktreeDirectoryForProject,
  siblingWorktreeDirectory,
} from "./worktree-placement.js";

const projectRoot = path.resolve("/srv/work/paseo");

function project(
  overrides: Partial<Parameters<typeof createPersistedProjectRecord>[0]> & {
    repos?: ReturnType<typeof createPersistedProjectRecord>["repos"];
    worktreeLocation?: ReturnType<typeof createPersistedProjectRecord>["worktreeLocation"];
  } = {},
) {
  const { repos, worktreeLocation, ...rest } = overrides;
  return {
    ...createPersistedProjectRecord({
      projectId: "prj_1",
      rootPath: projectRoot,
      kind: "non_git",
      displayName: "paseo",
      createdAt: "2026-10-22T00:00:00.000Z",
      updatedAt: "2026-10-22T00:00:00.000Z",
      ...rest,
    }),
    repos: repos ?? [],
    worktreeLocation: worktreeLocation ?? null,
  };
}

describe("resolveWorktreeDirectoryForProject", () => {
  it("keeps the managed root by default", () => {
    expect(
      resolveWorktreeDirectoryForProject({
        project: project(),
        repoRoot: path.join(projectRoot, "fork"),
      }),
    ).toBeUndefined();
  });

  it("places sibling worktrees next to the repository, including the project root repo", () => {
    const sibling = project({ worktreeLocation: "sibling" });
    expect(
      resolveWorktreeDirectoryForProject({
        project: sibling,
        repoRoot: path.join(projectRoot, "fork"),
      }),
    ).toBe(path.join(projectRoot, "fork.wt"));
    expect(resolveWorktreeDirectoryForProject({ project: sibling, repoRoot: projectRoot })).toBe(
      path.join(path.dirname(projectRoot), "paseo.wt"),
    );
    expect(siblingWorktreeDirectory(path.join(projectRoot, "plugins", "pstack"))).toBe(
      path.join(projectRoot, "plugins", "pstack.wt"),
    );
  });

  it("lets a repository override the project default", () => {
    const mixed = project({
      worktreeLocation: "sibling",
      repos: [
        {
          relPath: "upstream",
          commonDirHash: null,
          role: "reference",
          pinned: false,
          worktreeLocation: "managed",
          adoptedWorktrees: [],
        },
        {
          relPath: "fork",
          commonDirHash: null,
          role: "normal",
          pinned: false,
          worktreeLocation: { kind: "directory", path: "tmp/wt" },
          adoptedWorktrees: [],
        },
      ],
    });
    expect(
      resolveWorktreeDirectoryForProject({
        project: mixed,
        repoRoot: path.join(projectRoot, "upstream"),
      }),
    ).toBeUndefined();
    expect(
      resolveWorktreeDirectoryForProject({
        project: mixed,
        repoRoot: path.join(projectRoot, "fork"),
      }),
    ).toBe(path.join(projectRoot, "tmp", "wt"));
  });
});

describe("repoRelPath", () => {
  it("uses catalog notation", () => {
    expect(repoRelPath(projectRoot, projectRoot)).toBe(".");
    expect(repoRelPath(projectRoot, path.join(projectRoot, "plugins", "pstack"))).toBe(
      "plugins/pstack",
    );
    expect(repoRelPath(projectRoot, path.join(projectRoot, "..", "other"))).toBeNull();
  });
});

describe("assertWorktreeSourceInProject", () => {
  it("accepts paths in the folder or in a known checkout and rejects the rest", () => {
    const record = project();
    const external = path.resolve("/srv/elsewhere/fork-wt");
    expect(() =>
      assertWorktreeSourceInProject({
        project: record,
        sourceCwd: path.join(projectRoot, "fork", "packages"),
        knownCheckoutPaths: [],
      }),
    ).not.toThrow();
    expect(() =>
      assertWorktreeSourceInProject({
        project: record,
        sourceCwd: path.join(external, "packages"),
        knownCheckoutPaths: [external],
      }),
    ).not.toThrow();
    expect(() =>
      assertWorktreeSourceInProject({
        project: record,
        sourceCwd: path.resolve("/srv/unrelated"),
        knownCheckoutPaths: [external],
      }),
    ).toThrow(/not part of project/);
  });
});
