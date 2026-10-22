import { describe, expect, it } from "vitest";
import type { ProjectRepoPayload } from "@getpaseo/protocol/messages";
import { buildProjectRepoTree } from "./project-repo-tree";

function repo(
  relPath: string,
  rootPath: string,
  checkouts: Array<Partial<ProjectRepoPayload["checkouts"][number]> & { path: string }>,
  role: ProjectRepoPayload["role"] = "normal",
): ProjectRepoPayload {
  return {
    relPath,
    rootPath,
    commonDirHash: "hash",
    role,
    pinned: false,
    worktreeLocation: null,
    checkouts: checkouts.map((checkout, index) => ({
      branch: null,
      head: null,
      isMain: index === 0,
      detached: false,
      bare: false,
      insideProject: true,
      managed: index === 0,
      ...checkout,
    })),
  };
}

describe("buildProjectRepoTree", () => {
  const repos = [
    repo("upstream", "/p/upstream", [{ path: "/p/upstream", branch: "main" }], "reference"),
    repo("fork", "/p/fork", [
      { path: "/p/fork", branch: "main" },
      { path: "/p/fork.wt/feat", branch: "feat", managed: true },
      { path: "/elsewhere/fork-build", branch: "build" },
    ]),
    repo("secret", "/p/secret", [{ path: "/p/secret", branch: "main" }], "hidden"),
  ];

  it("attaches workspaces to the deepest matching checkout and keeps the rest", () => {
    const tree = buildProjectRepoTree({
      repos,
      workspaces: [
        { workspaceKey: "h:fork-main", workspaceDirectory: "/p/fork" },
        { workspaceKey: "h:fork-sub", workspaceDirectory: "/p/fork/packages/app" },
        { workspaceKey: "h:feat", workspaceDirectory: "/p/fork.wt/feat" },
        { workspaceKey: "h:build", workspaceDirectory: "/elsewhere/fork-build/src" },
        { workspaceKey: "h:root", workspaceDirectory: "/p" },
        { workspaceKey: "h:secret", workspaceDirectory: "/p/secret" },
        { workspaceKey: "h:nodir" },
      ],
    });

    expect(tree.repos.map((entry) => [entry.name, entry.role])).toEqual([
      ["fork", "normal"],
      ["upstream", "reference"],
    ]);
    const fork = tree.repos[0]!;
    expect(
      fork.checkouts.map((checkout) => [checkout.branch, checkout.managed, checkout.workspaceKeys]),
    ).toEqual([
      ["main", true, ["h:fork-main", "h:fork-sub"]],
      ["build", false, ["h:build"]],
      ["feat", true, ["h:feat"]],
    ]);
    expect(tree.otherWorkspaceKeys).toEqual(["h:root", "h:secret", "h:nodir"]);
  });

  it("names the project-root repository after its folder and normalizes separators", () => {
    const tree = buildProjectRepoTree({
      repos: [repo(".", "C:\\work\\paseo", [{ path: "C:\\work\\paseo", branch: "main" }])],
      workspaces: [{ workspaceKey: "w", workspaceDirectory: "C:/work/paseo/packages" }],
    });
    expect(tree.repos[0]?.name).toBe("paseo");
    expect(tree.repos[0]?.checkouts[0]?.workspaceKeys).toEqual(["w"]);
  });
});
