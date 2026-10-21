import { useMemo } from "react";
import { createPluginClientStateSource } from "../client-state/source";
import { createPluginNavigation } from "../navigation";
import { useInstalledPlugins } from "../registry";
import { buildPluginClientSlashCommands, type PluginClientSlashCommand } from "./contributions";
export type { PluginClientSlashCommand } from "./contributions";

export function usePluginClientSlashCommands(input: {
  serverId: string;
  workspaceId: string | null | undefined;
  agentId: string;
  prepareWorkspace?: () => Promise<string | null>;
}): PluginClientSlashCommand[] {
  const installed = useInstalledPlugins();
  return useMemo(() => {
    return buildPluginClientSlashCommands({
      plugins: installed.filter((plugin) => plugin.serverId === input.serverId),
      state: createPluginClientStateSource(input.serverId),
      workspaceId: input.workspaceId,
      agentId: input.agentId,
      prepareWorkspace: input.prepareWorkspace,
      createNavigation: (workspaceId) =>
        createPluginNavigation({ serverId: input.serverId, workspaceId }),
    });
  }, [input.agentId, input.serverId, input.workspaceId, input.prepareWorkspace, installed]);
}
