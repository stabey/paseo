import { describe, expect, it } from "vitest";
import {
  archiveRepoWorktrees,
  mergeCheckoutAndArchive,
  resolveCheckoutMenuActions,
  type ProjectRepoActionsClient,
  UncommittedChangesError,
} from "@/projects/project-repo-actions";
import type { ProjectRepoTreeCheckout, ProjectRepoTreeRepo } from "@/projects/project-repo-tree";

function checkout(overrides: Partial<ProjectRepoTreeCheckout>): ProjectRepoTreeCheckout {
  return {
    path: "/p/app",
    branch: "main",
    isMain: false,
    detached: false,
    managed: false,
    workspaceKeys: [],
    ...overrides,
  };
}

const main = checkout({ path: "/p/app", branch: "main", isMain: true, managed: true });
const managed = checkout({ path: "/p/app.wt/feat", branch: "feat", managed: true });
const external = checkout({ path: "/elsewhere/fix", branch: "fix" });
const detached = checkout({ path: "/p/app.wt/d", branch: null, detached: true, managed: true });

const repo: ProjectRepoTreeRepo = {
  relPath: "app",
  name: "app",
  rootPath: "/p/app",
  role: "normal",
  worktreeLocation: "sibling",
  checkouts: [main, managed, external, detached],
};

interface Call {
  method: string;
  args: unknown[];
}

function recordingClient(
  options: { failArchiveFor?: string; mergeError?: string; dirty?: boolean } = {},
) {
  const calls: Call[] = [];
  const client: ProjectRepoActionsClient = {
    adoptProjectRepoWorktree: async (...args) => {
      calls.push({ method: "adopt", args });
    },
    refreshProjectRepos: async (...args) => {
      calls.push({ method: "refresh", args });
    },
    setProjectRepoSettings: async (...args) => {
      calls.push({ method: "settings", args });
    },
    checkoutMerge: async (...args) => {
      calls.push({ method: "merge", args });
      let error: { code: "NOT_ALLOWED" | "UNKNOWN"; message: string } | null = null;
      if (options.dirty) {
        error = { code: "NOT_ALLOWED", message: `${args[0]} has uncommitted changes` };
      } else if (options.mergeError) {
        error = { code: "UNKNOWN", message: options.mergeError };
      }
      return {
        cwd: args[0],
        success: error === null,
        error,
        requestId: "r",
      } as Awaited<ReturnType<ProjectRepoActionsClient["checkoutMerge"]>>;
    },
    archivePaseoWorktree: async (...args) => {
      calls.push({ method: "archive", args });
      const failed = args[0].worktreePath === options.failArchiveFor;
      return {
        success: !failed,
        removedAgents: [],
        error: failed ? { code: "NOT_ALLOWED", message: "not owned" } : null,
        requestId: "r",
      } as Awaited<ReturnType<ProjectRepoActionsClient["archivePaseoWorktree"]>>;
    },
  };
  return { client, calls };
}

describe("resolveCheckoutMenuActions", () => {
  it("never archives the main checkout", () => {
    expect(resolveCheckoutMenuActions({ repo, checkout: main })).toEqual({
      newWorkspace: true,
      adopt: false,
      archive: false,
      mergeAndArchive: false,
    });
  });

  it("offers merge and archive for a managed worktree on its own branch", () => {
    expect(resolveCheckoutMenuActions({ repo, checkout: managed })).toEqual({
      newWorkspace: true,
      adopt: false,
      archive: true,
      mergeAndArchive: true,
    });
  });

  it("offers only adoption for an external worktree", () => {
    expect(resolveCheckoutMenuActions({ repo, checkout: external })).toEqual({
      newWorkspace: false,
      adopt: true,
      archive: false,
      mergeAndArchive: false,
    });
  });

  it("does not merge a detached worktree", () => {
    expect(resolveCheckoutMenuActions({ repo, checkout: detached }).mergeAndArchive).toBe(false);
  });
});

describe("mergeCheckoutAndArchive", () => {
  it("merges into the main checkout's branch and then archives the worktree", async () => {
    const { client, calls } = recordingClient();
    await mergeCheckoutAndArchive({ client, repo, checkout: managed });
    expect(calls).toEqual([
      {
        method: "merge",
        args: [
          "/p/app.wt/feat",
          {
            baseRef: "main",
            strategy: "merge",
            requireCleanSource: true,
          },
        ],
      },
      { method: "archive", args: [{ worktreePath: "/p/app.wt/feat", scope: "worktree" }] },
    ]);
  });

  it("keeps the worktree when the merge fails", async () => {
    const { client, calls } = recordingClient({ mergeError: "conflict" });
    await expect(mergeCheckoutAndArchive({ client, repo, checkout: managed })).rejects.toThrow(
      "conflict",
    );
    expect(calls.map((call) => call.method)).toEqual(["merge"]);
  });

  it("refuses to merge a worktree with uncommitted changes", async () => {
    const { client, calls } = recordingClient({ dirty: true });
    await expect(
      mergeCheckoutAndArchive({ client, repo, checkout: managed }),
    ).rejects.toBeInstanceOf(UncommittedChangesError);
    expect(calls.map((call) => call.method)).toEqual(["merge"]);
  });
});

describe("archiveRepoWorktrees", () => {
  it("archives managed linked worktrees only and reports failures per path", async () => {
    const { client, calls } = recordingClient({ failArchiveFor: "/p/app.wt/d" });
    const result = await archiveRepoWorktrees({ client, repo });
    expect(calls.map((call) => (call.args[0] as { worktreePath: string }).worktreePath)).toEqual([
      "/p/app.wt/feat",
      "/p/app.wt/d",
    ]);
    expect(result.archived).toEqual(["/p/app.wt/feat"]);
    expect(result.failed.map((entry) => entry.path)).toEqual(["/p/app.wt/d"]);
  });
});
