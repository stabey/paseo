import { useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { router, type Href } from "expo-router";
import type { ProjectRepoPayload } from "@getpaseo/protocol/messages";
import type { PickerItem } from "@/screens/new-workspace-picker-item";
import { useSessionStore } from "@/stores/session-store";
import { buildHostWorkspaceRoute } from "@/utils/host-routes";
import type { NewWorkspaceFormProps } from "./form";
import { normalizePath, pathContains } from "./repo-picker";

/**
 * Checking out a pull request whose head branch is already checked out somewhere would make the
 * host create the new worktree on `<branch>-2`. The New workspace form says where the branch is
 * and, when a workspace already lives there, offers to open it instead.
 */

export interface ExistingBranchCheckout {
  path: string;
  isMain: boolean;
}

export function findExistingBranchCheckout(input: {
  repo: ProjectRepoPayload | null;
  branchName: string | null;
}): ExistingBranchCheckout | null {
  const { repo, branchName } = input;
  if (!repo || !branchName) return null;
  const checkout = repo.checkouts.find(
    (candidate) => !candidate.bare && !candidate.detached && candidate.branch === branchName,
  );
  return checkout ? { path: checkout.path, isMain: checkout.isMain } : null;
}

/** The workspace opened at the checkout itself, else the shallowest one inside it. */
export function findWorkspaceInCheckout(input: {
  workspaces: Iterable<{ id: string; workspaceDirectory: string }>;
  checkoutPath: string;
}): string | null {
  const root = normalizePath(input.checkoutPath);
  let best: { workspaceId: string; depth: number } | null = null;
  for (const workspace of input.workspaces) {
    const directory = normalizePath(workspace.workspaceDirectory);
    if (!pathContains(root, directory)) continue;
    if (!best || directory.length < best.depth) {
      best = { workspaceId: workspace.id, depth: directory.length };
    }
  }
  return best?.workspaceId ?? null;
}

function pullRequestHeadBranch(item: PickerItem | null): string | null {
  if (item?.kind !== "github-pr") return null;
  return item.item.headRefName?.trim() || null;
}

export function useExistingCheckoutNotice(input: {
  serverId: string;
  repo: ProjectRepoPayload | null;
  /** COMPAT(workspaceMultiplicity): hosts without it always create a worktree. */
  supportsWorkspaceMultiplicity: boolean;
  effectiveIsolation: "local" | "worktree";
  selectedItem: PickerItem | null;
}): NewWorkspaceFormProps["existingCheckout"] {
  const { t } = useTranslation();
  const { serverId, repo, selectedItem } = input;
  const isWorktree =
    !input.supportsWorkspaceMultiplicity || input.effectiveIsolation === "worktree";
  const branchName = isWorktree ? pullRequestHeadBranch(selectedItem) : null;
  const checkout = useMemo(
    () => findExistingBranchCheckout({ repo, branchName }),
    [branchName, repo],
  );
  const workspaces = useSessionStore((state) => state.sessions[serverId]?.workspaces ?? null);
  const workspaceId = useMemo(
    () =>
      checkout && workspaces
        ? findWorkspaceInCheckout({ workspaces: workspaces.values(), checkoutPath: checkout.path })
        : null,
    [checkout, workspaces],
  );
  const openWorkspace = useCallback(() => {
    if (workspaceId) router.navigate(buildHostWorkspaceRoute(serverId, workspaceId) as Href);
  }, [serverId, workspaceId]);

  if (!checkout || !branchName) return null;
  return {
    message: t("newWorkspace.existingCheckout.message", {
      branch: branchName,
      path: checkout.path,
    }),
    actionLabel: workspaceId ? t("newWorkspace.existingCheckout.open") : null,
    onAction: workspaceId ? openWorkspace : null,
  };
}
