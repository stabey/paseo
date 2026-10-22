import { useCallback, useMemo, useState } from "react";
import type { ProjectRepoPayload } from "@getpaseo/protocol/messages";
import type { ComboboxOption } from "@/components/ui/combobox";
import { getHostProjectId, type HostProjectListItem } from "@/projects/host-projects";
import { useSessionStore } from "@/stores/session-store";
import { selectProject } from "@/stores/session-store-hooks/selectors";

/**
 * Which repository of a multi-repository project a new workspace is cut from.
 *
 * A project is a folder; the host reports the repositories inside it. The picker offers each
 * one, defaults to the repository that contains the directory the user came from (the routed
 * `sourceDirectory`: a checkout row, a fork, a workspace), and otherwise to the first normal
 * repository. The chosen repository's main checkout becomes the source directory for branch
 * suggestions and for the create request. Projects without repository data report `hasRepos:
 * false` and leave the source directory to the project picker.
 */

const REPO_OPTION_PREFIX = "repo:";

export interface NewWorkspaceRepoPickerState {
  hasRepos: boolean;
  repoOptions: ComboboxOption[];
  selectedRepo: ProjectRepoPayload | null;
  selectedRepoOptionId: string;
  triggerLabel: string;
  /** Main checkout of the selected repository; null when the project reports no repositories. */
  sourceDirectory: string | null;
  handleSelectRepoOption: (id: string) => void;
}

export function repoOptionId(relPath: string): string {
  return `${REPO_OPTION_PREFIX}${relPath}`;
}

export function repoDisplayName(repo: Pick<ProjectRepoPayload, "relPath" | "rootPath">): string {
  if (repo.relPath !== ".") return repo.relPath;
  const normalized = repo.rootPath.replace(/\\/g, "/").replace(/\/+$/, "");
  const index = normalized.lastIndexOf("/");
  return index === -1 ? normalized : normalized.slice(index + 1) || normalized;
}

export function repoMainCheckoutPath(repo: ProjectRepoPayload): string {
  return (
    repo.checkouts.find((checkout) => checkout.isMain && !checkout.bare)?.path ?? repo.rootPath
  );
}

/** Repositories a workspace can be created in: not hidden, in a stable order. */
export function selectableRepos(repos: readonly ProjectRepoPayload[]): ProjectRepoPayload[] {
  const order = { normal: 0, reference: 1, hidden: 2 } as const;
  return repos
    .filter((repo) => repo.role !== "hidden")
    .sort(
      (left, right) =>
        order[left.role] - order[right.role] || left.relPath.localeCompare(right.relPath),
    );
}

function normalizePath(path: string): string {
  const unified = path.replace(/\\/g, "/");
  return unified.length > 1 ? unified.replace(/\/+$/, "") : unified;
}

function pathContains(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(root.endsWith("/") ? root : `${root}/`);
}

/**
 * The repository a directory belongs to: the one with the deepest checkout containing it, so a
 * worktree nested in another checkout wins over its parent.
 */
export function resolveRepoForDirectory(
  repos: readonly ProjectRepoPayload[],
  directory: string | null | undefined,
): ProjectRepoPayload | null {
  if (!directory) return null;
  const target = normalizePath(directory);
  let best: { repo: ProjectRepoPayload; depth: number } | null = null;
  for (const repo of repos) {
    for (const checkout of repo.checkouts) {
      const root = normalizePath(checkout.path);
      if (!pathContains(root, target)) continue;
      if (!best || root.length > best.depth) best = { repo, depth: root.length };
    }
  }
  return best?.repo ?? null;
}

export function resolveInitialRepo(input: {
  repos: readonly ProjectRepoPayload[];
  preferredDirectory: string | null | undefined;
}): ProjectRepoPayload | null {
  return (
    resolveRepoForDirectory(input.repos, input.preferredDirectory) ??
    input.repos.find((repo) => repo.role === "normal") ??
    input.repos[0] ??
    null
  );
}

export function useNewWorkspaceRepoPicker(input: {
  selectedServerId: string;
  selectedProject: HostProjectListItem | null;
  preferredDirectory: string | null | undefined;
}): NewWorkspaceRepoPickerState {
  const { selectedServerId, selectedProject, preferredDirectory } = input;
  const projectId = selectedProject ? getHostProjectId(selectedProject, selectedServerId) : null;
  const reportedRepos = useSessionStore(
    useCallback(
      (state) => selectProject(state, selectedServerId, projectId)?.repos ?? null,
      [selectedServerId, projectId],
    ),
  );
  const repos = useMemo(() => selectableRepos(reportedRepos ?? []), [reportedRepos]);
  const [manual, setManual] = useState<{ projectViewKey: string; relPath: string } | null>(null);

  const manualRepo =
    manual && manual.projectViewKey === selectedProject?.viewKey
      ? (repos.find((repo) => repo.relPath === manual.relPath) ?? null)
      : null;
  const selectedRepo = manualRepo ?? resolveInitialRepo({ repos, preferredDirectory });

  const repoOptions = useMemo<ComboboxOption[]>(
    () => repos.map((repo) => ({ id: repoOptionId(repo.relPath), label: repoDisplayName(repo) })),
    [repos],
  );
  const handleSelectRepoOption = useCallback(
    (id: string) => {
      if (!selectedProject || !id.startsWith(REPO_OPTION_PREFIX)) return;
      setManual({
        projectViewKey: selectedProject.viewKey,
        relPath: id.slice(REPO_OPTION_PREFIX.length),
      });
    },
    [selectedProject],
  );

  return {
    hasRepos: repos.length > 0,
    repoOptions,
    selectedRepo,
    selectedRepoOptionId: selectedRepo ? repoOptionId(selectedRepo.relPath) : "",
    triggerLabel: selectedRepo ? repoDisplayName(selectedRepo) : "",
    sourceDirectory: selectedRepo ? repoMainCheckoutPath(selectedRepo) : null,
    handleSelectRepoOption,
  };
}
