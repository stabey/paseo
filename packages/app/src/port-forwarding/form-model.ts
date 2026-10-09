import type { WorkspacePort } from "@getpaseo/protocol/workspace-ports";

function parsePort(value: string): number | null {
  if (!/^\d+$/.test(value.trim())) return null;
  const port = Number(value);
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : null;
}

export function openPortForm() {
  const observers = new Set<() => void>();
  let fields = {
    label: "",
    port: "",
    localPort: "",
    protocol: "http" as WorkspacePort["protocol"],
    resetKey: 0,
  };
  function derive() {
    const port = parsePort(fields.port);
    const localPort = fields.localPort.trim() ? parsePort(fields.localPort) : undefined;
    return {
      ...fields,
      invalidPort: fields.port.length > 0 && port === null,
      invalidLocalPort: localPort === null,
      canSubmit: port !== null && localPort !== null && fields.label.length <= 80,
    };
  }
  let state = derive();
  function update(patch: Partial<typeof fields>) {
    fields = { ...fields, ...patch };
    state = derive();
    for (const observer of observers) observer();
  }
  return {
    getState: () => state,
    subscribe: (observer: () => void) => {
      observers.add(observer);
      return () => observers.delete(observer);
    },
    close: () => observers.clear(),
    setLabel: (label: string) => update({ label }),
    setPort: (port: string) => update({ port }),
    setLocalPort: (localPort: string) => update({ localPort }),
    setProtocol: (protocol: WorkspacePort["protocol"]) => update({ protocol }),
    reset: () =>
      update({
        label: "",
        port: "",
        localPort: "",
        protocol: "http",
        resetKey: fields.resetKey + 1,
      }),
    submission: () => {
      if (!state.canSubmit) throw new Error("Enter a port between 1 and 65535");
      return {
        port: Number(fields.port),
        label: fields.label.trim(),
        protocol: fields.protocol,
        localPort: fields.localPort.trim() ? Number(fields.localPort) : undefined,
      };
    },
  };
}
