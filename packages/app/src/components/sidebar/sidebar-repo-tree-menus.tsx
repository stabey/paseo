import { useCallback, useMemo, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import * as Clipboard from "expo-clipboard";
import { router, type Href } from "expo-router";
import {
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
} from "@/components/ui/context-menu";
import { useToast } from "@/contexts/toast-context";
import {
  adoptCheckout,
  archivableCheckouts,
  archiveCheckout,
  archiveRepoWorktrees,
  mainBranch,
  mergeCheckoutAndArchive,
  repoWorktreePlacement,
  resolveCheckoutMenuActions,
  setRepoReference,
  setRepoWorktreePlacement,
  type ProjectRepoActionsClient,
  type RepoWorktreePlacement,
  UncommittedChangesError,
} from "@/projects/project-repo-actions";
import type { ProjectRepoTreeCheckout, ProjectRepoTreeRepo } from "@/projects/project-repo-tree";
import { getHostRuntimeStore } from "@/runtime/host-runtime";
import { confirmDialog } from "@/utils/confirm-dialog";
import { buildNewWorkspaceRoute } from "@/utils/host-routes";

export interface RepoTreeActions {
  newWorkspace: (checkout: ProjectRepoTreeCheckout) => void;
  copyPath: (path: string) => void;
  adopt: (repo: ProjectRepoTreeRepo, checkout: ProjectRepoTreeCheckout) => void;
  archive: (checkout: ProjectRepoTreeCheckout) => void;
  mergeAndArchive: (repo: ProjectRepoTreeRepo, checkout: ProjectRepoTreeCheckout) => void;
  refresh: () => void;
  setReference: (repo: ProjectRepoTreeRepo, reference: boolean) => void;
  setPlacement: (repo: ProjectRepoTreeRepo, placement: RepoWorktreePlacement) => void;
  archiveAll: (repo: ProjectRepoTreeRepo) => void;
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

/**
 * Wires the tree's menu actions to the host client, with confirmation for anything that
 * deletes a worktree. Results reach the tree through the project descriptor update the host
 * pushes after each change, so nothing here touches the store.
 */
export function useRepoTreeActions(input: {
  serverId: string;
  projectId: string;
  displayName: string;
  onWorkspacePress?: () => void;
}): RepoTreeActions {
  const { serverId, projectId, displayName, onWorkspacePress } = input;
  const { t } = useTranslation();
  const toast = useToast();

  const run = useCallback(
    (action: (client: ProjectRepoActionsClient) => Promise<void>, success?: string) => {
      const client = getHostRuntimeStore().getClient(serverId);
      if (!client) {
        toast.error(t("sidebar.repoTree.toasts.hostDisconnected"));
        return;
      }
      void action(client)
        .then(() => {
          if (success) toast.show(success);
          return null;
        })
        .catch((error: unknown) => {
          toast.error(
            error instanceof UncommittedChangesError
              ? t("sidebar.repoTree.toasts.uncommittedChanges")
              : errorMessage(error, t("sidebar.repoTree.toasts.actionFailed")),
          );
        });
    },
    [serverId, t, toast],
  );

  const confirmThenRun = useCallback(
    (
      dialog: { title: string; message: string; confirmLabel: string },
      action: (client: ProjectRepoActionsClient) => Promise<void>,
      success?: string,
    ) => {
      void confirmDialog({
        ...dialog,
        cancelLabel: t("sidebar.repoTree.confirmations.cancel"),
        destructive: true,
      }).then((confirmed) => {
        if (confirmed) run(action, success);
        return null;
      });
    },
    [run, t],
  );

  return useMemo<RepoTreeActions>(
    () => ({
      newWorkspace: (checkout) => {
        onWorkspacePress?.();
        router.navigate(
          buildNewWorkspaceRoute({
            serverId,
            sourceDirectory: checkout.path,
            displayName,
            projectId,
          }) as Href,
        );
      },
      copyPath: (path) => {
        void Clipboard.setStringAsync(path);
        toast.copied(t("sidebar.workspace.toasts.pathCopied"));
      },
      adopt: (repo, checkout) =>
        run(
          (client) => adoptCheckout({ client, projectId, repo, checkout }),
          t("sidebar.repoTree.toasts.adopted"),
        ),
      archive: (checkout) =>
        confirmThenRun(
          {
            title: t("sidebar.repoTree.confirmations.archiveTitle"),
            message: t("sidebar.repoTree.confirmations.archiveMessage", { path: checkout.path }),
            confirmLabel: t("sidebar.repoTree.confirmations.archiveConfirm"),
          },
          (client) => archiveCheckout({ client, checkout }),
        ),
      mergeAndArchive: (repo, checkout) =>
        confirmThenRun(
          {
            title: t("sidebar.repoTree.confirmations.mergeTitle"),
            message: t("sidebar.repoTree.confirmations.mergeMessage", {
              branch: checkout.branch,
              base: mainBranch(repo),
              path: checkout.path,
            }),
            confirmLabel: t("sidebar.repoTree.confirmations.mergeConfirm"),
          },
          (client) => mergeCheckoutAndArchive({ client, repo, checkout }),
        ),
      refresh: () => run((client) => client.refreshProjectRepos(projectId)),
      setReference: (repo, reference) =>
        run((client) => setRepoReference({ client, projectId, repo, reference })),
      setPlacement: (repo, placement) =>
        run((client) => setRepoWorktreePlacement({ client, projectId, repo, placement })),
      archiveAll: (repo) =>
        confirmThenRun(
          {
            title: t("sidebar.repoTree.confirmations.archiveAllTitle"),
            message: t("sidebar.repoTree.confirmations.archiveAllMessage", {
              total: archivableCheckouts(repo).length,
              repo: repo.name,
            }),
            confirmLabel: t("sidebar.repoTree.confirmations.archiveConfirm"),
          },
          async (client) => {
            const result = await archiveRepoWorktrees({ client, repo });
            if (result.failed.length > 0) {
              throw new Error(
                t("sidebar.repoTree.toasts.archiveAllPartial", {
                  failed: result.failed.length,
                  total: result.failed.length + result.archived.length,
                }),
              );
            }
          },
        ),
    }),
    [confirmThenRun, displayName, onWorkspacePress, projectId, run, serverId, t, toast],
  );
}

export function CheckoutMenuItems({
  repo,
  checkout,
  actions,
}: {
  repo: ProjectRepoTreeRepo;
  checkout: ProjectRepoTreeCheckout;
  actions: RepoTreeActions;
}): ReactElement {
  const { t } = useTranslation();
  const available = resolveCheckoutMenuActions({ repo, checkout });
  const testId = `sidebar-checkout-menu-${checkout.path}`;
  const handlers = useMemo(
    () => ({
      newWorkspace: () => actions.newWorkspace(checkout),
      copyPath: () => actions.copyPath(checkout.path),
      adopt: () => actions.adopt(repo, checkout),
      mergeAndArchive: () => actions.mergeAndArchive(repo, checkout),
      archive: () => actions.archive(checkout),
    }),
    [actions, checkout, repo],
  );
  return (
    <>
      {available.newWorkspace ? (
        <ContextMenuItem testID={`${testId}-new-workspace`} onSelect={handlers.newWorkspace}>
          {t("sidebar.repoTree.newWorkspaceHere")}
        </ContextMenuItem>
      ) : null}
      <ContextMenuItem testID={`${testId}-copy-path`} onSelect={handlers.copyPath}>
        {t("sidebar.workspace.actions.copyPath")}
      </ContextMenuItem>
      {available.adopt ? (
        <ContextMenuItem
          testID={`${testId}-adopt`}
          description={t("sidebar.repoTree.actions.adoptDescription")}
          onSelect={handlers.adopt}
        >
          {t("sidebar.repoTree.actions.adopt")}
        </ContextMenuItem>
      ) : null}
      {available.mergeAndArchive || available.archive ? <ContextMenuSeparator /> : null}
      {available.mergeAndArchive ? (
        <ContextMenuItem testID={`${testId}-merge-archive`} onSelect={handlers.mergeAndArchive}>
          {t("sidebar.repoTree.actions.mergeAndArchive", { base: mainBranch(repo) })}
        </ContextMenuItem>
      ) : null}
      {available.archive ? (
        <ContextMenuItem testID={`${testId}-archive`} destructive onSelect={handlers.archive}>
          {t("sidebar.repoTree.actions.archive")}
        </ContextMenuItem>
      ) : null}
    </>
  );
}

export function RepoMenuItems({
  repo,
  actions,
}: {
  repo: ProjectRepoTreeRepo;
  actions: RepoTreeActions;
}): ReactElement {
  const { t } = useTranslation();
  const placement = repoWorktreePlacement(repo);
  const customDirectory = typeof repo.worktreeLocation === "object" && repo.worktreeLocation;
  const archivableCount = archivableCheckouts(repo).length;
  const testId = `sidebar-repo-menu-${repo.relPath}`;
  const handlers = useMemo(
    () => ({
      copyPath: () => actions.copyPath(repo.rootPath),
      toggleReference: () => actions.setReference(repo, repo.role !== "reference"),
      placeManaged: () => actions.setPlacement(repo, "managed"),
      placeSibling: () => actions.setPlacement(repo, "sibling"),
      archiveAll: () => actions.archiveAll(repo),
    }),
    [actions, repo],
  );
  return (
    <>
      <ContextMenuItem testID={`${testId}-refresh`} onSelect={actions.refresh}>
        {t("sidebar.repoTree.actions.refresh")}
      </ContextMenuItem>
      <ContextMenuItem testID={`${testId}-copy-path`} onSelect={handlers.copyPath}>
        {t("sidebar.workspace.actions.copyPath")}
      </ContextMenuItem>
      <ContextMenuItem
        testID={`${testId}-reference`}
        description={t("sidebar.repoTree.actions.referenceDescription")}
        onSelect={handlers.toggleReference}
      >
        {repo.role === "reference"
          ? t("sidebar.repoTree.actions.markNormal")
          : t("sidebar.repoTree.actions.markReference")}
      </ContextMenuItem>
      <ContextMenuSeparator />
      <ContextMenuLabel>{t("sidebar.repoTree.actions.placementLabel")}</ContextMenuLabel>
      <ContextMenuItem
        testID={`${testId}-placement-managed`}
        showSelectedCheck
        selected={!customDirectory && placement === "managed"}
        onSelect={handlers.placeManaged}
      >
        {t("sidebar.repoTree.actions.placementManaged")}
      </ContextMenuItem>
      <ContextMenuItem
        testID={`${testId}-placement-sibling`}
        showSelectedCheck
        selected={!customDirectory && placement === "sibling"}
        onSelect={handlers.placeSibling}
      >
        {t("sidebar.repoTree.actions.placementSibling")}
      </ContextMenuItem>
      {archivableCount > 0 ? (
        <>
          <ContextMenuSeparator />
          <ContextMenuItem
            testID={`${testId}-archive-all`}
            destructive
            onSelect={handlers.archiveAll}
          >
            {t("sidebar.repoTree.actions.archiveAll", { total: archivableCount })}
          </ContextMenuItem>
        </>
      ) : null}
    </>
  );
}
