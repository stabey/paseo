import { expect, test, vi } from "vitest";
import type { ConnectionState } from "@getpaseo/client/internal/daemon-client";
import {
  TunnelCloseReason,
  TunnelOpcode,
  type TunnelFrame,
} from "@getpaseo/protocol/binary-frames/index";
import {
  PortForwardingController,
  type TunnelClient,
  type PortForwardingBridge,
} from "./controller";
import { openPortForm } from "./form-model";

function fixture() {
  let connection: (state: ConnectionState) => void = () => {};
  let incoming: (frame: TunnelFrame) => void = () => {};
  let local: (id: string, frame: TunnelFrame) => void = () => {};
  let connected = true;
  const client: TunnelClient = {
    get isConnected() {
      return connected;
    },
    probeWorkspacePort: vi.fn(async () => {}),
    onTunnelFrame: (listener) => {
      incoming = listener;
      return () => {};
    },
    sendTunnelFrame: vi.fn(),
    subscribeConnectionStatus: (listener) => {
      connection = listener;
      return () => {};
    },
  };
  const bridge: PortForwardingBridge = {
    open: vi.fn(async () => ({ localPort: 43123 })),
    close: vi.fn(async () => {}),
    receive: vi.fn(async () => {}),
    listen: async (handler) => {
      local = handler;
      return () => {};
    },
  };
  const controller = new PortForwardingController(client, bridge);
  return {
    client,
    bridge,
    controller,
    disconnect: () => {
      connected = false;
      connection({ status: "disconnected" });
    },
    reconnect: () => {
      connected = true;
      connection({ status: "connected" });
    },
    incoming: (frame: TunnelFrame) => incoming(frame),
    local: (id: string, frame: TunnelFrame) => local(id, frame),
  };
}

test("deduplicates opens and exposes the allocated address; disconnect closes it and retry can restart", async () => {
  const f = fixture();
  const input = { workspaceId: "ws", port: 3000 };
  const [first, second] = await Promise.all([f.controller.start(input), f.controller.start(input)]);
  expect(first).toEqual(second);
  expect(first).toMatchObject({ ...input, status: "forwarding", localPort: 43123 });
  expect(f.bridge.open).toHaveBeenCalledTimes(1);
  f.disconnect();
  expect(f.controller.getState()[0]).toMatchObject({
    status: "error",
    error: "Host disconnected. Reconnect and retry forwarding.",
  });
  expect(f.bridge.close).toHaveBeenCalledWith(first.listenerId);
  f.reconnect();
  const retry = await f.controller.start(input);
  expect(retry.status).toBe("forwarding");
  expect(retry.listenerId).not.toBe(first.listenerId);
});

test("keeps probe errors visible and does not bind a port for an unreachable service", async () => {
  const f = fixture();
  vi.mocked(f.client.probeWorkspacePort).mockRejectedValue(new Error("Service is not listening"));
  await expect(f.controller.start({ workspaceId: "ws", port: 3000 })).rejects.toThrow(
    "Service is not listening",
  );
  expect(f.bridge.open).not.toHaveBeenCalled();
  expect(f.controller.getState()[0]).toMatchObject({
    status: "error",
    error: "Service is not listening",
  });
});

test("accepts a local connection while the listener's IPC acknowledgement is still pending", async () => {
  const f = fixture();
  vi.mocked(f.bridge.open).mockImplementation(async (input) => {
    f.local(input.listenerId, {
      opcode: TunnelOpcode.Open,
      streamId: "early-connection",
      workspaceId: input.workspaceId,
      port: input.port,
    });
    return { localPort: 43123 };
  });
  await f.controller.start({ workspaceId: "ws", port: 3000 });
  expect(f.client.sendTunnelFrame).toHaveBeenCalledWith({
    opcode: TunnelOpcode.Open,
    streamId: "early-connection",
    workspaceId: "ws",
    port: 3000,
  });
});

test("closes a listener whose open completed after disconnection", async () => {
  const f = fixture();
  let resolveOpen: (value: { localPort: number }) => void = () => {};
  vi.mocked(f.bridge.open).mockImplementation(
    () =>
      new Promise((resolve) => {
        resolveOpen = resolve;
      }),
  );
  const opening = f.controller.start({ workspaceId: "ws", port: 3000 });
  const rejected = expect(opening).rejects.toThrow("cancelled");
  await vi.waitFor(() => expect(f.bridge.open).toHaveBeenCalledTimes(1));
  f.disconnect();
  resolveOpen({ localPort: 43123 });
  await rejected;
  expect(f.controller.getState()[0].status).toBe("error");
  expect(f.bridge.close).toHaveBeenCalled();
});

test("routes only owned streams, and releases both halves after graceful completion", async () => {
  const f = fixture();
  const record = await f.controller.start({ workspaceId: "ws", port: 3000 });
  f.incoming({ opcode: TunnelOpcode.Opened, streamId: "foreign" });
  expect(f.bridge.receive).not.toHaveBeenCalled();
  f.local(record.listenerId, {
    opcode: TunnelOpcode.Open,
    streamId: "mine",
    workspaceId: "ws",
    port: 3000,
  });
  f.incoming({ opcode: TunnelOpcode.Opened, streamId: "mine" });
  f.local(record.listenerId, { opcode: TunnelOpcode.End, streamId: "mine" });
  f.incoming({ opcode: TunnelOpcode.End, streamId: "mine" });
  f.incoming({ opcode: TunnelOpcode.Credit, streamId: "mine", bytes: 1 });
  expect(f.bridge.receive).toHaveBeenCalledTimes(2);
  await f.controller.stop("ws", 3000);
  expect(f.controller.getState()).toEqual([]);
});

test("validates explicit local and remote ports and resets create inputs", () => {
  const form = openPortForm();
  form.setPort("3000x");
  expect(form.getState().canSubmit).toBe(false);
  form.setPort("3000");
  form.setLocalPort("65536");
  expect(form.getState().canSubmit).toBe(false);
  form.setLocalPort("");
  form.setLabel(" App ");
  expect(form.submission()).toEqual({
    port: 3000,
    label: "App",
    protocol: "http",
    localPort: undefined,
  });
  form.reset();
  expect(form.getState()).toMatchObject({ port: "", label: "", localPort: "", canSubmit: false });
});

test("revoking a target closes the local listener and exposes the reason", async () => {
  const f = fixture();
  const record = await f.controller.start({ workspaceId: "ws", port: 3000 });
  f.local(record.listenerId, {
    opcode: TunnelOpcode.Open,
    streamId: "revoked",
    workspaceId: "ws",
    port: 3000,
  });
  f.incoming({
    opcode: TunnelOpcode.Close,
    streamId: "revoked",
    reason: TunnelCloseReason.Forbidden,
  });
  expect(f.controller.getState()[0]).toMatchObject({
    status: "error",
    error: "Port forwarding permission or target was removed.",
  });
  expect(f.bridge.close).toHaveBeenCalledWith(record.listenerId);
});
