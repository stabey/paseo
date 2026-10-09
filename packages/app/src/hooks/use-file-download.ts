import { useCallback, useMemo } from "react";
import { useHosts, useHostRuntimeSnapshot } from "@/runtime/host-runtime";
import { useDownloadStore } from "@/stores/download-store";
import { useFileExplorerActions } from "@/hooks/use-file-explorer-actions";
import { i18n } from "@/i18n/i18next";

// Browser/Expo saving uses a byte buffer; bound it before the daemon begins streaming.
const CONNECTED_DOWNLOAD_MAX_BYTES = 64 * 1024 * 1024;

interface UseFileDownloadParams {
  serverId: string;
  workspaceId?: string | null;
  workspaceRoot: string;
}

/**
 * Returns a stable callback that downloads a single workspace file by its
 * workspace-relative path. Shared by the file explorer tree and the git diff
 * pane. Relay and local IPC downloads use the already authenticated connection.
 */
export function useFileDownload({
  serverId,
  workspaceId,
  workspaceRoot,
}: UseFileDownloadParams): (input: { fileName: string; path: string }) => void {
  const daemons = useHosts();
  const runtime = useHostRuntimeSnapshot(serverId);
  const daemonProfile = useMemo(
    () => daemons.find((daemon) => daemon.serverId === serverId),
    [daemons, serverId],
  );
  const normalizedWorkspaceRoot = useMemo(() => workspaceRoot.trim(), [workspaceRoot]);
  const workspaceScopeId = useMemo(
    () => workspaceId?.trim() || normalizedWorkspaceRoot,
    [normalizedWorkspaceRoot, workspaceId],
  );
  const { requestFileDownloadToken } = useFileExplorerActions({
    serverId,
    workspaceId,
    workspaceRoot: normalizedWorkspaceRoot,
  });
  const startDownload = useDownloadStore((state) => state.startDownload);

  return useCallback(
    ({ fileName, path }) => {
      if (!workspaceScopeId) {
        return;
      }
      void startDownload({
        serverId,
        scopeId: workspaceScopeId,
        fileName,
        path,
        daemonProfile,
        readConnectedFile:
          runtime?.activeConnection?.type !== "directTcp"
            ? async (targetPath) => {
                if (!runtime?.client?.isConnected)
                  throw new Error(i18n.t("workspace.terminal.hostDisconnected"));
                try {
                  return await runtime.client.readFile(
                    normalizedWorkspaceRoot,
                    targetPath,
                    undefined,
                    CONNECTED_DOWNLOAD_MAX_BYTES,
                  );
                } catch (error) {
                  if (error instanceof Error && error.message === "File is too large to display") {
                    throw new Error(i18n.t("downloads.connectedSizeLimit"), { cause: error });
                  }
                  throw error;
                }
              }
            : undefined,
        requestFileDownloadToken: (targetPath) => requestFileDownloadToken(targetPath),
      });
    },
    [
      daemonProfile,
      requestFileDownloadToken,
      serverId,
      startDownload,
      workspaceScopeId,
      runtime,
      normalizedWorkspaceRoot,
    ],
  );
}
