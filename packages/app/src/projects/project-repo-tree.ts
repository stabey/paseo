import type { ProjectRepoPayload } from "@getpaseo/protocol/messages";

/**
 * The sidebar's repository tree for one project: Repo > Checkout > workspaces.
 *
 * Workspaces are attached to the checkout whose directory is the longest prefix of the
 * workspace directory. That is a derived view: records are not rewritten, so a workspace the
 * host does not place under any known checkout (a plain folder in a mixed project, or a checkout
 * the scan has not seen yet) stays visible under the project as "other".
 */

export interface ProjectRepoTreeCheckout {
  path: string;
  branch: string | null;
  isMain: boolean;
  detached: boolean;
  /** Paseo may archive and delete it; false for worktrees created with plain git. */
  managed: boolean;
  workspaceKeys: string[];
}

export interface ProjectRepoTreeRepo {
  relPath: string;
  name: string;
  rootPath: string;
  role: ProjectRepoPayload["role"];
  /** Where new worktrees go; null = the host's managed folder. */
  worktreeLocation: ProjectRepoPayload["worktreeLocation"];
  checkouts: ProjectRepoTreeCheckout[];
}

export interface ProjectRepoTree {
  repos: ProjectRepoTreeRepo[];
  /** Workspace keys that match no checkout, in input order. */
  otherWorkspaceKeys: string[];
}

export interface ProjectRepoTreeWorkspace {
  workspaceKey: string;
  workspaceDirectory?: string;
}

const ROLE_ORDER: Record<ProjectRepoPayload["role"], number> = {
  normal: 0,
  reference: 1,
  hidden: 2,
};

export function buildProjectRepoTree(input: {
  repos: readonly ProjectRepoPayload[];
  workspaces: readonly ProjectRepoTreeWorkspace[];
}): ProjectRepoTree {
  const repos: ProjectRepoTreeRepo[] = input.repos
    .filter((repo) => repo.role !== "hidden")
    .map((repo) => ({
      relPath: repo.relPath,
      name: repo.relPath === "." ? baseName(repo.rootPath) : repo.relPath,
      rootPath: repo.rootPath,
      role: repo.role,
      worktreeLocation: repo.worktreeLocation,
      checkouts: repo.checkouts
        .filter((checkout) => !checkout.bare)
        .map((checkout) => ({
          path: checkout.path,
          branch: checkout.branch,
          isMain: checkout.isMain,
          detached: checkout.detached,
          managed: checkout.managed,
          workspaceKeys: [],
        }))
        .sort(compareCheckouts),
    }))
    .sort(
      (left, right) =>
        ROLE_ORDER[left.role] - ROLE_ORDER[right.role] || left.relPath.localeCompare(right.relPath),
    );

  const checkoutsByDepth = repos
    .flatMap((repo) => repo.checkouts)
    .map((checkout) => ({ checkout, normalized: normalizePath(checkout.path) }))
    // Longest path first so a worktree nested inside another checkout wins over its parent.
    .sort((left, right) => right.normalized.length - left.normalized.length);

  const otherWorkspaceKeys: string[] = [];
  for (const workspace of input.workspaces) {
    const directory = workspace.workspaceDirectory
      ? normalizePath(workspace.workspaceDirectory)
      : null;
    const match = directory
      ? checkoutsByDepth.find((entry) => isPathWithin(entry.normalized, directory))
      : undefined;
    if (match) {
      match.checkout.workspaceKeys.push(workspace.workspaceKey);
    } else {
      otherWorkspaceKeys.push(workspace.workspaceKey);
    }
  }

  return { repos, otherWorkspaceKeys };
}

function compareCheckouts(left: ProjectRepoTreeCheckout, right: ProjectRepoTreeCheckout): number {
  if (left.isMain !== right.isMain) return left.isMain ? -1 : 1;
  return (
    (left.branch ?? "").localeCompare(right.branch ?? "") || left.path.localeCompare(right.path)
  );
}

function normalizePath(path: string): string {
  const unified = path.replace(/\\/g, "/");
  return unified.length > 1 ? unified.replace(/\/+$/, "") : unified;
}

function isPathWithin(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(root.endsWith("/") ? root : `${root}/`);
}

function baseName(path: string): string {
  const normalized = normalizePath(path);
  const index = normalized.lastIndexOf("/");
  return index === -1 ? normalized : normalized.slice(index + 1) || normalized;
}
