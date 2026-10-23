import { dirname, resolve } from "node:path";

import { writePaseoWorktreePlacementMetadata } from "../../utils/worktree-metadata.js";
import { areEquivalentPaths } from "../../utils/path.js";
import type { PersistedProjectRecord, ProjectRegistry } from "../workspace-registry.js";
import { listCheckouts } from "./repo-discovery.js";

export class AdoptWorktreeError extends Error {
  constructor(
    readonly code: "project_not_found" | "repo_not_found" | "not_a_linked_checkout",
    message: string,
  ) {
    super(message);
    this.name = "AdoptWorktreeError";
  }
}

export interface AdoptWorktreeDeps {
  projectRegistry: Pick<ProjectRegistry, "get" | "update">;
  resolveDefaultBranch: (repoRoot: string) => Promise<string>;
}

/**
 * Brings a worktree somebody created with plain git under Paseo management.
 *
 * Two facts are written: a placement record in the worktree's git admin dir (what every
 * ownership check and the catalog's `managed` flag read) and the path in the project's
 * `adoptedWorktrees` (a record of the decision; it does not grant ownership, since git can reuse
 * the path for an unrelated worktree later). The worktree must be a linked checkout of the
 * repository; the main checkout is never adopted.
 */
export async function adoptWorktree(
  deps: AdoptWorktreeDeps,
  input: { projectId: string; relPath: string; worktreePath: string },
): Promise<PersistedProjectRecord> {
  const project = await deps.projectRegistry.get(input.projectId);
  if (!project || project.archivedAt) {
    throw new AdoptWorktreeError("project_not_found", `Project not found: ${input.projectId}`);
  }
  const repoRoot = resolve(project.rootPath, input.relPath);
  const worktreePath = resolve(input.worktreePath);

  let checkouts: Awaited<ReturnType<typeof listCheckouts>>;
  try {
    checkouts = await listCheckouts(repoRoot, project.rootPath);
  } catch (error) {
    throw new AdoptWorktreeError(
      "repo_not_found",
      `Not a repository of this project: ${input.relPath} (${error instanceof Error ? error.message : String(error)})`,
    );
  }
  const checkout = checkouts.find((entry) => areEquivalentPaths(entry.path, worktreePath));
  if (!checkout || checkout.isMain || checkout.bare) {
    throw new AdoptWorktreeError(
      "not_a_linked_checkout",
      `Not a linked worktree of ${input.relPath}: ${input.worktreePath}`,
    );
  }

  writePaseoWorktreePlacementMetadata(checkout.path, {
    worktreesRoot: dirname(checkout.path),
    baseRefName: await deps.resolveDefaultBranch(repoRoot),
  });

  const updated = await deps.projectRegistry.update(project.projectId, (record) => {
    const existing = record.repos.find((repo) => repo.relPath === input.relPath);
    const adoptedWorktrees = existing?.adoptedWorktrees ?? [];
    if (adoptedWorktrees.some((entry) => areEquivalentPaths(entry, checkout.path))) return record;
    const next = {
      relPath: input.relPath,
      commonDirHash: existing?.commonDirHash ?? null,
      role: existing?.role ?? "normal",
      pinned: existing?.pinned ?? false,
      worktreeLocation: existing?.worktreeLocation ?? null,
      adoptedWorktrees: [...adoptedWorktrees, checkout.path],
    };
    return {
      ...record,
      repos: [...record.repos.filter((repo) => repo.relPath !== input.relPath), next],
      updatedAt: new Date().toISOString(),
    };
  });
  if (!updated) {
    throw new AdoptWorktreeError("project_not_found", `Project not found: ${input.projectId}`);
  }
  return updated;
}
