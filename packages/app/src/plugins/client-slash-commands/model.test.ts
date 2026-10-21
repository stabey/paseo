import { describe, expect, it, vi } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import { createPaseoApi } from "@getpaseo/client";
import { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { PluginWorkspaceSnapshot } from "@getpaseo/plugin";
import type { InstalledPlugin } from "../types";
import { buildPluginClientSlashCommands } from "./contributions";
import {
  executePluginClientSlashCommand,
  mergeSlashCommandSources,
  resolvePluginClientSlashCommand,
} from "./model";

// Panel validation does not need the app's live plugin registry.
vi.mock("../registry", () => ({ pluginRegistry: { getSnapshot: () => [] } }));

describe("plugin client slash commands", () => {
  it("uses built-in, plugin, then provider precedence", () => {
    const collision = vi.fn();
    const result = mergeSlashCommandSources({
      builtIn: [{ name: "clear", aliases: ["new"] }],
      plugins: [
        { name: "clear", pluginId: "review" },
        { name: "new", pluginId: "alias-collision" },
        { name: "review", pluginId: "alpha" },
        { name: "review", pluginId: "beta" },
      ],
      provider: [{ name: "review" }, { name: "usage" }],
      onPluginCollision: collision,
    });

    expect(result.map(({ source, command }) => `${source}:${command.name}`)).toEqual([
      "built-in:clear",
      "plugin:review",
      "provider:usage",
    ]);
    expect(collision).toHaveBeenCalledTimes(3);
  });

  it("passes the trimmed raw remainder as args", () => {
    const command = { name: "review" };
    expect(
      resolvePluginClientSlashCommand({
        text: "  /review   foo bar  ",
        hasAttachments: false,
        commands: [command],
      }),
    ).toEqual({ command, args: "foo bar" });
    expect(
      resolvePluginClientSlashCommand({
        text: "/review foo",
        hasAttachments: true,
        commands: [command],
      }),
    ).toBeNull();
  });

  it("runs the client handler and reports failures", async () => {
    const run = vi.fn(async (_args: string) => undefined);
    const onError = vi.fn();
    await executePluginClientSlashCommand({ command: { run }, args: "foo", onError });
    expect(run).toHaveBeenCalledWith("foo");
    expect(onError).not.toHaveBeenCalled();

    const failure = new Error("review failed");
    await executePluginClientSlashCommand({
      command: { run: vi.fn().mockRejectedValue(failure) },
      args: "bar",
      onError,
    });
    expect(onError).toHaveBeenCalledWith(failure);
  });

  it("does not make the composer wait for a never-resolving handler", () => {
    const run = vi.fn(() => new Promise<void>(() => undefined));

    expect(
      executePluginClientSlashCommand({ command: { run }, args: "foo", onError: vi.fn() }),
    ).toBeUndefined();
    expect(run).toHaveBeenCalledWith("foo");
  });
});

function creationCommands() {
  const workspaces = new Map<string, PluginWorkspaceSnapshot>();
  const openPanel = vi.fn();
  const onSubmit = vi.fn<
    Extract<InstalledPlugin["clientSlashCommands"][number], { context: "workspace" }>["onSubmit"]
  >((context) => {
    context.openPanel("setup");
  });
  const plugin: InstalledPlugin = {
    id: "pstack",
    serverId: "host",
    clientBundle: "bundle",
    lifetime: new AbortController(),
    paseo: createPaseoApi(
      new DaemonClient({ url: "ws://127.0.0.1:1", clientId: "slash-test", clientType: "cli" }),
    ),
    invoke: async () => null,
    queryClient: new QueryClient(),
    cleanup() {},
    settingsScreens: [],
    surfaces: [],
    sidebarItems: { header: [], footer: [] },
    legacySidebarItems: [],
    workspacePanels: [
      {
        id: "setup",
        title: "Setup",
        icon: "Scan",
        context: "workspace",
        locations: ["workspace"],
        Component: () => null,
      },
    ],
    commandCenterItems: [],
    attachmentSources: [],
    themes: [],
    timelineTransformers: [],
    timelineRenderers: [],
    clientSlashCommands: [
      {
        name: "pstack-setup",
        description: "Setup",
        argumentHint: "",
        context: "workspace",
        onSubmit,
      },
      {
        name: "agent-only",
        description: "Agent",
        argumentHint: "",
        context: "agent",
        onSubmit: vi.fn(),
      },
    ],
  };
  const workspace: PluginWorkspaceSnapshot = {
    id: "selected-worktree",
    projectId: "selected-project",
    projectDisplayName: "Selected project",
    projectRootPath: "/projects/repo",
    directory: "/worktrees/selected-branch",
    projectKind: "git",
    kind: "worktree",
    name: "selected-branch",
    title: null,
    status: "done",
    statusEnteredAt: null,
    archivingAt: null,
    diffStat: null,
  };
  const source = {
    plugins: [plugin],
    workspaceId: null,
    agentId: "draft",
    state: {
      subscribe: () => () => {},
      getAgent: () => null,
      getWorkspace: (id: string) => workspaces.get(id) ?? null,
    },
    createNavigation: vi.fn((workspaceId: string) => ({
      openSettings() {},
      openSurface() {},
      openAgentPanel() {},
      openWorkspacePanel: (pluginId: string, panelId: string) =>
        openPanel({ workspaceId, pluginId, panelId }),
    })),
  };
  return { source, workspace, workspaces, onSubmit, openPanel };
}

describe("plugin commands before workspace creation", () => {
  it("offers workspace commands without an agent and prepares the selected checkout only on submit", async () => {
    const f = creationCommands();
    const prepareWorkspace = vi.fn(async () => {
      f.workspaces.set(f.workspace.id, f.workspace);
      return f.workspace.id;
    });
    expect(buildPluginClientSlashCommands(f.source)).toEqual([]);
    const commands = buildPluginClientSlashCommands({ ...f.source, prepareWorkspace });
    expect(commands.map((c) => c.name)).toEqual(["pstack-setup"]);
    expect(prepareWorkspace).not.toHaveBeenCalled();
    await commands[0]!.run("options");
    expect(prepareWorkspace).toHaveBeenCalledOnce();
    expect(f.onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({ workspace: f.workspace, args: "options" }),
    );
    expect(f.openPanel).toHaveBeenCalledWith({
      workspaceId: f.workspace.id,
      pluginId: "pstack",
      panelId: "setup",
    });
  });

  it("does not invoke a plugin if creation fails or the user leaves the screen", async () => {
    const f = creationCommands();
    const failure = new Error("checkout failed");
    const prepareWorkspace = vi
      .fn<() => Promise<string | null>>()
      .mockRejectedValueOnce(failure)
      .mockResolvedValue(null);
    const commands = buildPluginClientSlashCommands({ ...f.source, prepareWorkspace });
    await expect(commands[0]!.run("")).rejects.toThrow("checkout failed");
    await commands[0]!.run("");
    expect(f.onSubmit).not.toHaveBeenCalled();
    expect(f.source.createNavigation).not.toHaveBeenCalled();
  });

  it("deduplicates simultaneous submissions during workspace creation", async () => {
    const f = creationCommands();
    let release: (id: string) => void = () => {};
    const prepareWorkspace = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          release = resolve;
        }),
    );
    const commands = buildPluginClientSlashCommands({ ...f.source, prepareWorkspace });
    const first = commands[0]!.run("first");
    const second = commands[0]!.run("second");
    f.workspaces.set(f.workspace.id, f.workspace);
    release(f.workspace.id);
    await Promise.all([first, second]);
    expect(prepareWorkspace).toHaveBeenCalledOnce();
    expect(f.onSubmit).toHaveBeenCalledOnce();
  });

  it("runs in an existing workspace without invoking the creation callback", async () => {
    const f = creationCommands();
    f.workspaces.set(f.workspace.id, f.workspace);
    const prepareWorkspace = vi.fn();
    const commands = buildPluginClientSlashCommands({
      ...f.source,
      workspaceId: f.workspace.id,
      prepareWorkspace,
    });
    await commands[0]!.run("");
    expect(prepareWorkspace).not.toHaveBeenCalled();
    expect(f.onSubmit).toHaveBeenCalledOnce();
  });
});
