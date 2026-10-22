import { describe, expect, it } from "vitest";
import type { ProjectRepoPayload } from "@getpaseo/protocol/messages";
import {
  repoDisplayName,
  repoMainCheckoutPath,
  resolveInitialRepo,
  resolveRepoForDirectory,
  selectableRepos,
} from "./repo-picker";

function repo(
  relPath: string,
  rootPath: string,
  checkoutPaths: string[],
  role: ProjectRepoPayload["role"] = "normal",
): ProjectRepoPayload {
  return {
    relPath,
    rootPath,
    commonDirHash: "h",
    role,
    pinned: false,
    worktreeLocation: null,
    checkouts: checkoutPaths.map((path, index) => ({
      path,
      branch: index === 0 ? "main" : `wt-${index}`,
      head: null,
      isMain: index === 0,
      detached: false,
      bare: false,
      insideProject: true,
      managed: index === 0,
    })),
  };
}

const repos = [
  repo("upstream", "/p/upstream", ["/p/upstream"], "reference"),
  repo("secret", "/p/secret", ["/p/secret"], "hidden"),
  repo("fork", "/p/fork", ["/p/fork", "/p/fork.wt/feat"]),
  repo(".", "/p", ["/p"]),
];

describe("new workspace repo picker", () => {
  it("orders selectable repositories and hides hidden ones", () => {
    expect(selectableRepos(repos).map(repoDisplayName)).toEqual(["p", "fork", "upstream"]);
  });

  it("prefers the repository whose deepest checkout contains the directory", () => {
    const selectable = selectableRepos(repos);
    expect(resolveRepoForDirectory(selectable, "/p/fork.wt/feat/src")?.relPath).toBe("fork");
    expect(resolveRepoForDirectory(selectable, "/p/fork/packages")?.relPath).toBe("fork");
    expect(resolveRepoForDirectory(selectable, "/p/docs")?.relPath).toBe(".");
    expect(resolveRepoForDirectory(selectable, "/elsewhere")).toBeNull();
  });

  it("falls back to the first normal repository and uses the main checkout as source", () => {
    const selectable = selectableRepos(repos);
    const initial = resolveInitialRepo({ repos: selectable, preferredDirectory: null });
    expect(initial?.relPath).toBe(".");
    expect(repoMainCheckoutPath(selectable[1]!)).toBe("/p/fork");
    expect(
      resolveInitialRepo({
        repos: selectableRepos([repos[0]!]),
        preferredDirectory: "/nowhere",
      })?.relPath,
    ).toBe("upstream");
  });
});
