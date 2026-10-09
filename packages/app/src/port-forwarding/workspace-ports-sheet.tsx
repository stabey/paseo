import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { Text, View } from "react-native";
import { useMutation } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import * as Clipboard from "expo-clipboard";
import { StyleSheet } from "react-native-unistyles";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { WorkspacePort } from "@getpaseo/protocol/workspace-ports";
import { AdaptiveModalSheet } from "@/components/adaptive-modal-sheet";
import { Button } from "@/components/ui/button";
import { Field, FormTextInput } from "@/components/ui/form-field";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { useIsCompactFormFactor } from "@/constants/layout";
import { useSessionStore } from "@/stores/session-store";
import { openServiceUrl } from "@/utils/open-service-url";
import { getPortForwarding } from "./desktop";
import { openPortForm } from "./form-model";
import type { ForwardedPort, PortForwardingController } from "./controller";

interface Props {
  serverId: string;
  workspaceId: string;
  onClose: () => void;
  onOpenUrlInBrowserTab?: (url: string) => void;
}

export function WorkspacePortsSheet(props: Props) {
  const { t } = useTranslation();
  const header = useMemo(() => ({ title: t("workspace.ports.title") }), [t]);
  const client = useSessionStore((state) => state.sessions[props.serverId]?.client);
  const supported = useSessionStore(
    (state) =>
      state.sessions[props.serverId]?.serverInfo?.features?.workspacePortForwarding === true,
  );
  return (
    <AdaptiveModalSheet
      visible
      header={header}
      onClose={props.onClose}
      testID="workspace-ports-sheet"
      desktopMaxWidth={600}
    >
      {client && supported ? (
        <PortsContent key={props.workspaceId} {...props} client={client} />
      ) : (
        <Text style={styles.muted}>{t("workspace.ports.unavailable")}</Text>
      )}
    </AdaptiveModalSheet>
  );
}

function usePortForm() {
  const [model] = useState(openPortForm);
  useEffect(() => () => model.close(), [model]);
  return { model, state: useSyncExternalStore(model.subscribe, model.getState) };
}

function PortsContent({
  serverId,
  workspaceId,
  client,
  onOpenUrlInBrowserTab,
}: Props & { client: DaemonClient }) {
  const { t } = useTranslation();
  const size = useIsCompactFormFactor() ? "md" : "sm";
  const workspace = useSessionStore((state) =>
    state.sessions[serverId]?.workspaces.get(workspaceId),
  );
  const controller = getPortForwarding(client);
  const forwarded = useSyncExternalStore(controller.subscribe, controller.getState);
  const { model, state } = usePortForm();
  const setSavedPorts = (portForwards: WorkspacePort[]) => {
    const current = useSessionStore.getState().sessions[serverId]?.workspaces.get(workspaceId);
    if (current)
      useSessionStore.getState().mergeWorkspaces(serverId, [{ ...current, portForwards }]);
  };
  const ports = new Map<number, WorkspacePort & { managed: boolean }>();
  for (const script of workspace?.scripts ?? []) {
    if (script.type === "service" && script.lifecycle === "running" && script.port) {
      ports.set(script.port, {
        port: script.port,
        label: script.scriptName,
        protocol: "http",
        managed: true,
      });
    }
  }
  for (const port of workspace?.portForwards ?? [])
    ports.set(port.port, { ...port, managed: false });
  const save = useMutation({
    mutationFn: async () => {
      const { port, localPort, ...configuration } = model.submission();
      setSavedPorts(await client.setWorkspacePort({ workspaceId, port, configuration }));
      model.reset();
      // Connection errors belong to the saved row, where the user can retry.
      await controller.start({ workspaceId, port, localPort }).catch(() => {});
    },
  });
  const remove = useMutation({
    mutationFn: async (port: number) => {
      setSavedPorts(await client.setWorkspacePort({ workspaceId, port, configuration: null }));
      await controller.stop(workspaceId, port);
    },
  });
  const handleSave = useCallback(() => save.mutate(), [save]);
  const handleRemove = useCallback((port: number) => remove.mutate(port), [remove]);
  return (
    <View style={styles.content}>
      {[...ports.values()].map((port) => (
        <PortRow
          key={port.port}
          port={port}
          workspaceId={workspaceId}
          controller={controller}
          state={forwarded.find(
            (entry) => entry.workspaceId === workspaceId && entry.port === port.port,
          )}
          onRemove={handleRemove}
          removing={remove.isPending}
          onOpenUrlInBrowserTab={onOpenUrlInBrowserTab}
        />
      ))}
      {ports.size === 0 ? <Text style={styles.muted}>{t("workspace.ports.empty")}</Text> : null}
      <View key={state.resetKey} style={styles.form}>
        <Field label={t("workspace.ports.label")}>
          <FormTextInput
            size={size}
            onChangeText={model.setLabel}
            maxLength={80}
            testID="port-label"
          />
        </Field>
        <View style={styles.columns}>
          <View style={styles.column}>
            <Field
              label={t("workspace.ports.remotePort")}
              error={state.invalidPort ? t("workspace.ports.invalidPort") : null}
            >
              <FormTextInput
                size={size}
                onChangeText={model.setPort}
                keyboardType="number-pad"
                testID="port-remote"
              />
            </Field>
          </View>
          <View style={styles.column}>
            <Field
              label={t("workspace.ports.localPort")}
              error={state.invalidLocalPort ? t("workspace.ports.invalidPort") : null}
            >
              <FormTextInput
                size={size}
                onChangeText={model.setLocalPort}
                placeholder={t("workspace.ports.automatic")}
                keyboardType="number-pad"
                testID="port-local"
              />
            </Field>
          </View>
        </View>
        <Field label={t("workspace.ports.protocol")}>
          <SegmentedControl
            size={size}
            options={protocolOptions}
            value={state.protocol}
            onValueChange={model.setProtocol}
          />
        </Field>
        <Button
          size={size}
          onPress={handleSave}
          disabled={!state.canSubmit}
          loading={save.isPending}
          testID="port-save"
        >
          {t("workspace.ports.add")}
        </Button>
      </View>
      {save.error || remove.error ? (
        <Text accessibilityRole="alert" style={styles.error}>
          {(save.error ?? remove.error)?.message}
        </Text>
      ) : null}
    </View>
  );
}

const protocolOptions = [
  { label: "HTTP", value: "http" },
  { label: "HTTPS", value: "https" },
  { label: "TCP", value: "tcp" },
] satisfies Array<{ label: string; value: WorkspacePort["protocol"] }>;

function PortRow({
  port,
  workspaceId,
  controller,
  state,
  onRemove,
  removing,
  onOpenUrlInBrowserTab,
}: {
  port: WorkspacePort & { managed: boolean };
  workspaceId: string;
  controller: PortForwardingController;
  state?: ForwardedPort;
  onRemove: (port: number) => void;
  removing: boolean;
  onOpenUrlInBrowserTab?: (url: string) => void;
}) {
  const { t } = useTranslation();
  const action = useMutation({
    mutationFn: async (intent: "start" | "stop" | "open" | "copy") => {
      if (intent === "stop") return controller.stop(workspaceId, port.port);
      const forward = await controller.start({ workspaceId, port: port.port });
      const address = `127.0.0.1:${forward.localPort}`;
      const url = port.protocol === "tcp" ? address : `${port.protocol}://${address}`;
      if (intent === "copy") await Clipboard.setStringAsync(url);
      if (intent === "open") await openServiceUrl(url, { openInApp: onOpenUrlInBrowserTab });
    },
  });
  const active = state?.status === "forwarding";
  const pending = state?.status === "connecting" || action.isPending;
  const handleToggle = useCallback(
    () => action.mutate(active ? "stop" : "start"),
    [action, active],
  );
  const handleOpen = useCallback(() => action.mutate("open"), [action]);
  const handleCopy = useCallback(() => action.mutate("copy"), [action]);
  const handleRemove = useCallback(() => onRemove(port.port), [onRemove, port.port]);
  return (
    <View style={styles.port} testID={`forwarded-port-${port.port}`}>
      <Text style={styles.name}>
        {port.label || String(port.port)} · {port.port} ·{" "}
        {t(port.managed ? "workspace.ports.managed" : "workspace.ports.manual")}
      </Text>
      <Text selectable style={styles.muted}>
        {active
          ? `${port.port} → 127.0.0.1:${state.localPort}`
          : t(pending ? "workspace.ports.connecting" : "workspace.ports.stopped")}
      </Text>
      <View style={styles.actions}>
        <Button size="sm" variant="outline" loading={pending} onPress={handleToggle}>
          {t(active ? "workspace.ports.stop" : "workspace.ports.start")}
        </Button>
        {active && port.protocol !== "tcp" ? (
          <Button size="sm" variant="ghost" onPress={handleOpen}>
            {t("workspace.ports.open")}
          </Button>
        ) : null}
        {active ? (
          <Button size="sm" variant="ghost" onPress={handleCopy}>
            {t("workspace.ports.copy")}
          </Button>
        ) : null}
        {!port.managed ? (
          <Button size="sm" variant="ghost" disabled={removing || pending} onPress={handleRemove}>
            {t("workspace.ports.remove")}
          </Button>
        ) : null}
      </View>
      {state?.error || action.error ? (
        <Text accessibilityRole="alert" style={styles.error}>
          {state?.error ?? action.error?.message}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  content: { gap: theme.spacing[4] },
  port: {
    gap: theme.spacing[2],
    paddingBottom: theme.spacing[3],
    borderBottomWidth: 1,
    borderColor: theme.colors.border,
  },
  form: { gap: theme.spacing[3] },
  columns: { flexDirection: "row", gap: theme.spacing[3] },
  column: { flex: 1 },
  actions: { flexDirection: "row", flexWrap: "wrap", gap: theme.spacing[2] },
  name: { color: theme.colors.foreground, fontSize: theme.fontSize.base },
  muted: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  error: { color: theme.colors.palette.red[300], fontSize: theme.fontSize.sm },
}));
