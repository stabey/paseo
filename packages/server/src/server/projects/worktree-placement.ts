import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";

import { expandTilde } from "../../utils/path.js";
import type {
  PersistedProjectRecord,
  PersistedProjectRepoWorktreeLocation,
  ProjectRegistry,
  WorkspaceRegistry,
} from "../workspace-registry.js";
import { areEquivalentPaths } from "../../utils/path.js";

/**
 * Where a new worktree of `repoRoot` goes, according to the project that owns the repository.
 *
 * - `managed` (default): the daemon's `<worktreesRoot>/<hash>/<slug>` root; returns undefined.
 * - `sibling`: `<parent of repo>/<repo>.wt/<slug>`. For a repository nested in the project folder
 *   that is inside the project; for a repository that is the project root it is beside it, so a
 *   worktree never lands inside the working tree it was cut from.
 * - `{ kind: "directory", path }`: an absolute directory, or one relative to the project root.
 *
 * Per-repository settings win over the project default. Without a project (legacy cwd-only
 * requests from workspaces that are not registered) the managed root is used.
 */
export function resolveWorktreeDirectoryForProject(input: {
  project: PersistedProjectRecord;
  repoRoot: string;
}): string | undefined {
  const relPath = repoRelPath(input.project.rootPath, input.repoRoot);
  const settings = relPath
    ? input.project.repos.find((repo) => repo.relPath === relPath)
    : undefined;
  const location: PersistedProjectRepoWorktreeLocation | null =
    settings?.worktreeLocation ?? input.project.worktreeLocation ?? null;
  if (!location || location === "managed") return undefined;
  if (location === "sibling") return siblingWorktreeDirectory(input.repoRoot);
  return resolve(input.project.rootPath, expandTilde(location.path));
}

export function siblingWorktreeDirectory(repoRoot: string): string {
  const resolved = resolve(repoRoot);
  return resolve(dirname(resolved), `${basename(resolved)}.wt`);
}

/** Catalog-style relative path of a repository root, or null when it is outside the project. */
export function repoRelPath(projectRoot: string, repoRoot: string): string | null {
  const rel = relative(resolve(projectRoot), resolve(repoRoot));
  if (rel === "") return ".";
  if (rel.startsWith("..") || isAbsolute(rel)) return null;
  return rel.split(sep).join("/");
}

export interface WorktreePlacementResolverDeps {
  projectRegistry: Pick<ProjectRegistry, "get">;
  workspaceRegistry: Pick<WorkspaceRegistry, "list">;
}

/**
 * Finds the project a worktree request belongs to: the explicit `projectId`, else the project
 * of the workspace whose directory is the request's source cwd.
 */
export async function resolveProjectForWorktreeSource(
  deps: WorktreePlacementResolverDeps,
  input: { projectId?: string; sourceCwd: string },
): Promise<PersistedProjectRecord | null> {
  if (input.projectId) {
    const project = await deps.projectRegistry.get(input.projectId);
    return project && !project.archivedAt ? project : null;
  }
  const workspaces = await deps.workspaceRegistry.list();
  const source = workspaces.find(
    (workspace) => !workspace.archivedAt && areEquivalentPaths(workspace.cwd, input.sourceCwd),
  );
  if (!source) return null;
  const project = await deps.projectRegistry.get(source.projectId);
  return project && !project.archivedAt ? project : null;
}

export class WorktreeSourceOutsideProjectError extends Error {
  constructor(
    readonly projectId: string,
    readonly sourceCwd: string,
  ) {
    super(`Worktree source is not part of project ${projectId}: ${sourceCwd}`);
    this.name = "WorktreeSourceOutsideProjectError";
  }
}

/**
 * A worktree request that names a project must cut from a checkout of one of that project's
 * repositories: a path under the project folder, or a checkout the catalog already lists
 * (worktrees can live outside the folder).
 */
export function assertWorktreeSourceInProject(input: {
  project: PersistedProjectRecord;
  sourceCwd: string;
  knownCheckoutPaths: readonly string[];
}): void {
  if (repoRelPath(input.project.rootPath, input.sourceCwd) !== null) return;
  const inside = input.knownCheckoutPaths.some((checkout) => {
    const rel = relative(resolve(checkout), resolve(input.sourceCwd));
    return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
  });
  if (!inside) {
    throw new WorktreeSourceOutsideProjectError(input.project.projectId, input.sourceCwd);
  }
}
