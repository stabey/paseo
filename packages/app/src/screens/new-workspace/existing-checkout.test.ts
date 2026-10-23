import { describe, expect, it } from "vitest";
import type { ProjectRepoPayload } from "@getpaseo/protocol/messages";
import { findExistingBranchCheckout, findWorkspaceInCheckout } from "./existing-checkout";

function checkout(
  overrides: Partial<ProjectRepoPayload["checkouts"][number]>,
): ProjectRepoPayload["checkouts"][number] {
  return {
    path: "/p/app",
    branch: "main",
    head: null,
    isMain: false,
    detached: false,
    bare: false,
    insideProject: true,
    managed: true,
    ...overrides,
  };
}

const repo: ProjectRepoPayload = {
  relPath: "app",
  rootPath: "/p/app",
  commonDirHash: "h",
  role: "normal",
  pinned: false,
  worktreeLocation: null,
  checkouts: [
    checkout({ path: "/p/app", branch: "main", isMain: true }),
    checkout({ path: "/p/app.wt/fix", branch: "fix-login" }),
    checkout({ path: "/p/app.wt/detached", branch: "old", detached: true }),
  ],
};

describe("findExistingBranchCheckout", () => {
  it("finds the checkout that has the branch", () => {
    expect(findExistingBranchCheckout({ repo, branchName: "fix-login" })).toEqual({
      path: "/p/app.wt/fix",
      isMain: false,
    });
  });

  it("ignores detached checkouts and unknown branches", () => {
    expect(findExistingBranchCheckout({ repo, branchName: "old" })).toBeNull();
    expect(findExistingBranchCheckout({ repo, branchName: "other" })).toBeNull();
    expect(findExistingBranchCheckout({ repo: null, branchName: "fix-login" })).toBeNull();
  });
});

describe("findWorkspaceInCheckout", () => {
  it("prefers the workspace at the checkout root over one nested inside it", () => {
    expect(
      findWorkspaceInCheckout({
        checkoutPath: "/p/app.wt/fix/",
        workspaces: [
          { id: "nested", workspaceDirectory: "/p/app.wt/fix/packages/web" },
          { id: "root", workspaceDirectory: "/p/app.wt/fix" },
          { id: "sibling", workspaceDirectory: "/p/app.wt/fix-2" },
        ],
      }),
    ).toBe("root");
  });

  it("returns null when no workspace lives in the checkout", () => {
    expect(
      findWorkspaceInCheckout({
        checkoutPath: "/p/app.wt/fix",
        workspaces: [{ id: "sibling", workspaceDirectory: "/p/app.wt/fix-2" }],
      }),
    ).toBeNull();
  });
});
