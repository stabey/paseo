import type { PluginClientStateSource } from "@getpaseo/plugin/client/host";
import {
  createPluginAgentActionContext,
  createPluginWorkspaceActionContext,
  type PluginNavigation,
} from "../actions";
import type { InstalledPlugin } from "../types";

export interface PluginClientSlashCommand {
  pluginId: string;
  name: string;
  description: string;
  argumentHint: string;
  run(args: string): Promise<void>;
}

export function buildPluginClientSlashCommands(input: {
  plugins: readonly InstalledPlugin[];
  state: PluginClientStateSource;
  workspaceId: string | null | undefined;
  agentId: string;
  createNavigation(workspaceId: string): PluginNavigation;
  /** Creates the selected workspace without an agent, only after command submission. */
  prepareWorkspace?: () => Promise<string | null>;
}): PluginClientSlashCommand[] {
  if (!input.workspaceId && !input.prepareWorkspace) return [];
  // Submission can arrive twice before React applies the creation screen's pending lock.
  let pendingCreationCommand: Promise<void> | undefined;
  return input.plugins.flatMap((plugin) =>
    plugin.clientSlashCommands.flatMap((contribution) => {
      if (input.workspaceId && !input.state.getWorkspace(input.workspaceId)) return [];
      if (contribution.context === "agent") {
        const agent = input.state.getAgent(input.agentId);
        if (!input.workspaceId || agent?.workspaceId !== input.workspaceId) return [];
      }
      async function submit(args: string) {
        const workspaceId = input.workspaceId ?? (await input.prepareWorkspace?.());
        // Leaving the creation screen cancels the command, not the workspace creation.
        if (!workspaceId) return;
        const navigation = input.createNavigation(workspaceId);
        const common = { plugin, navigation, state: input.state, workspaceId };
        if (contribution.context === "agent") {
          const context = createPluginAgentActionContext({ ...common, agentId: input.agentId });
          if (context) await contribution.onSubmit({ ...context, args });
        } else {
          const context = createPluginWorkspaceActionContext(common);
          if (!context) throw new Error("The workspace is no longer available");
          await contribution.onSubmit({ ...context, args });
        }
      }
      return [
        {
          pluginId: plugin.id,
          name: contribution.name,
          description: contribution.description,
          argumentHint: contribution.argumentHint,
          run(args: string) {
            if (input.workspaceId) return submit(args);
            pendingCreationCommand ??= submit(args).finally(() => {
              pendingCreationCommand = undefined;
            });
            return pendingCreationCommand;
          },
        },
      ];
    }),
  );
}
