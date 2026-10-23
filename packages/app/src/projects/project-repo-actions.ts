import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { ProjectRepoTreeCheckout, ProjectRepoTreeRepo } from "@/projects/project-repo-tree";

/**
 * Actions behind the sidebar repository tree's checkout and repository menus.
 *
 * Archiving a checkout goes through the worktree-scoped archive: the host archives every
 * workspace in the directory and removes the worktree when it owns it (created by Paseo, placed
 * by Paseo next to the repository, or adopted). External worktrees must be adopted first.
 */

export type ProjectRepoActionsClient = Pick<
  DaemonClient,
  | "adoptProjectRepoWorktree"
  | "archivePaseoWorktree"
  | "checkoutMerge"
  | "refreshProjectRepos"
  | "setProjectRepoSettings"
>;

export interface CheckoutMenuActions {
  newWorkspace: boolean;
  adopt: boolean;
  archive: boolean;
  /** Merge the checkout's branch into the main checkout's branch, then archive. */
  mergeAndArchive: boolean;
}

export function resolveCheckoutMenuActions(input: {
  repo: ProjectRepoTreeRepo;
  checkout: ProjectRepoTreeCheckout;
}): CheckoutMenuActions {
  const { repo, checkout } = input;
  const linkedManaged = checkout.managed && !checkout.isMain;
  return {
    newWorkspace: checkout.managed || checkout.isMain,
    adopt: !checkout.isMain && !checkout.managed,
    archive: linkedManaged,
    mergeAndArchive:
      linkedManaged &&
      !checkout.detached &&
      checkout.branch !== null &&
      mainBranch(repo) !== null &&
      checkout.branch !== mainBranch(repo),
  };
}

/** Linked worktrees Paseo may delete; the main checkout and external worktrees are left alone. */
export function archivableCheckouts(repo: ProjectRepoTreeRepo): ProjectRepoTreeCheckout[] {
  return repo.checkouts.filter((checkout) => checkout.managed && !checkout.isMain);
}

export function mainBranch(repo: ProjectRepoTreeRepo): string | null {
  return repo.checkouts.find((checkout) => checkout.isMain)?.branch ?? null;
}

export async function adoptCheckout(input: {
  client: ProjectRepoActionsClient;
  projectId: string;
  repo: ProjectRepoTreeRepo;
  checkout: ProjectRepoTreeCheckout;
}): Promise<void> {
  await input.client.adoptProjectRepoWorktree({
    projectId: input.projectId,
    relPath: input.repo.relPath,
    worktreePath: input.checkout.path,
  });
}

export async function archiveCheckout(input: {
  client: ProjectRepoActionsClient;
  checkout: ProjectRepoTreeCheckout;
}): Promise<void> {
  const payload = await input.client.archivePaseoWorktree({
    worktreePath: input.checkout.path,
    scope: "worktree",
  });
  if (!payload.success) {
    throw new Error(payload.error?.message ?? `Failed to archive ${input.checkout.path}`);
  }
}

export async function mergeCheckoutAndArchive(input: {
  client: ProjectRepoActionsClient;
  repo: ProjectRepoTreeRepo;
  checkout: ProjectRepoTreeCheckout;
}): Promise<void> {
  const baseRef = mainBranch(input.repo);
  if (!baseRef) {
    throw new Error(`${input.repo.name} has no branch checked out in its main checkout`);
  }
  // Archive deletes the worktree, so anything not committed would be lost after the merge. The
  // host checks git itself; `requireCleanTarget` reads the cached status, which can be stale in
  // either direction (a file written or deleted seconds ago), so it is not used here.
  const payload = await input.client.checkoutMerge(input.checkout.path, {
    baseRef,
    strategy: "merge",
    requireCleanSource: true,
  });
  if (payload.error?.code === "NOT_ALLOWED") {
    throw new UncommittedChangesError(input.checkout.path);
  }
  if (payload.error) {
    throw new Error(payload.error.message);
  }
  await archiveCheckout({ client: input.client, checkout: input.checkout });
}

export class UncommittedChangesError extends Error {
  constructor(public readonly path: string) {
    super(`${path} has uncommitted changes`);
    this.name = "UncommittedChangesError";
  }
}

export interface ArchiveRepoWorktreesResult {
  archived: string[];
  failed: Array<{ path: string; error: unknown }>;
}

/** One at a time: each archive runs teardown and `git worktree remove` on the same repository. */
export async function archiveRepoWorktrees(input: {
  client: ProjectRepoActionsClient;
  repo: ProjectRepoTreeRepo;
}): Promise<ArchiveRepoWorktreesResult> {
  const result: ArchiveRepoWorktreesResult = { archived: [], failed: [] };
  for (const checkout of archivableCheckouts(input.repo)) {
    try {
      await archiveCheckout({ client: input.client, checkout });
      result.archived.push(checkout.path);
    } catch (error) {
      result.failed.push({ path: checkout.path, error });
    }
  }
  return result;
}

export type RepoWorktreePlacement = "managed" | "sibling";

export function repoWorktreePlacement(repo: ProjectRepoTreeRepo): RepoWorktreePlacement {
  return repo.worktreeLocation === "sibling" ? "sibling" : "managed";
}

export async function setRepoWorktreePlacement(input: {
  client: ProjectRepoActionsClient;
  projectId: string;
  repo: ProjectRepoTreeRepo;
  placement: RepoWorktreePlacement;
}): Promise<void> {
  await input.client.setProjectRepoSettings({
    projectId: input.projectId,
    relPath: input.repo.relPath,
    worktreeLocation: input.placement,
  });
}

export async function setRepoReference(input: {
  client: ProjectRepoActionsClient;
  projectId: string;
  repo: ProjectRepoTreeRepo;
  reference: boolean;
}): Promise<void> {
  await input.client.setProjectRepoSettings({
    projectId: input.projectId,
    relPath: input.repo.relPath,
    role: input.reference ? "reference" : "normal",
  });
}
