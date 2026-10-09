import net from "node:net";
import http from "node:http";
import { once } from "node:events";
import { createHash, randomBytes } from "node:crypto";
import { setImmediate as turn } from "node:timers/promises";
import { afterEach, expect, test } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import { WorkspaceTunnel } from "../../../server/src/server/port-forwarding/forwarder.js";
import {
  decodeTunnelFrame,
  encodeTunnelFrame,
  TunnelOpcode,
  TunnelCloseReason,
  type TunnelFrame,
} from "@getpaseo/protocol/binary-frames/index";
import { PortForwarding } from "./port-forwarding.js";
import { TUNNEL_WINDOW_BYTES } from "@getpaseo/protocol/binary-frames/index";
import { createClientChannel, createDaemonChannel, type Transport } from "@getpaseo/relay/e2ee";
import { exportPublicKey, generateKeyPair } from "@getpaseo/relay";

const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const fn of cleanup.splice(0).toReversed()) fn();
});

async function listen(server: net.Server): Promise<number> {
  cleanup.push(() => server.close());
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing address");
  return address.port;
}

function wire(port: number) {
  const frames: TunnelFrame[] = [];
  const daemon = new WorkspaceTunnel({
    authorizeTarget: async (workspace, target) => workspace === "workspace-a" && target === port,
    send: async (frame) => {
      frames.push(frame);
      await turn();
      const decoded = decodeTunnelFrame(encodeTunnelFrame(frame));
      if (decoded) desktop.receive("listener", decoded);
    },
  });
  const desktop = new PortForwarding(async (_listener, frame) => {
    await turn();
    const decoded = decodeTunnelFrame(encodeTunnelFrame(frame));
    if (decoded) daemon.receive(decoded);
  });
  cleanup.push(
    () => daemon.dispose(),
    () => desktop.dispose(),
  );
  return { daemon, desktop, frames };
}

test("forwards HTTP upload/download and WebSocket frames through the same private port", async () => {
  const server = http.createServer((request, response) => {
    const hash = createHash("sha256");
    request.on("data", (chunk) => hash.update(chunk));
    request.on("end", () => response.end(hash.digest("hex")));
  });
  const wsServer = new WebSocketServer({ server });
  cleanup.push(() => wsServer.close());
  wsServer.on("connection", (socket) => socket.on("message", (data) => socket.send(data)));
  const port = await listen(server);
  const { desktop } = wire(port);
  const local = await desktop.open({
    listenerId: "listener",
    workspaceId: "workspace-a",
    port,
    localPort: 0,
  });
  const bytes = randomBytes(3 * 1024 * 1024);
  const response = await fetch(`http://127.0.0.1:${local.localPort}/upload`, {
    method: "POST",
    body: bytes,
    headers: { Connection: "close" },
  });
  expect(await response.text()).toBe(createHash("sha256").update(bytes).digest("hex"));
  const socket = new WebSocket(`ws://127.0.0.1:${local.localPort}/hmr`);
  cleanup.push(() => socket.terminate());
  await once(socket, "open");
  const message = once(socket, "message");
  socket.send(bytes);
  const [echo] = await message;
  expect(Buffer.from(echo).equals(bytes)).toBe(true);
}, 15_000);

test("preserves half-close and all response bytes with a slow receiver", async () => {
  const response = randomBytes(2 * 1024 * 1024);
  let uploaded = 0;
  const server = net.createServer({ allowHalfOpen: true }, (socket) => {
    cleanup.push(() => socket.destroy());
    socket.on("data", (chunk) => {
      uploaded += chunk.length;
    });
    socket.on("end", () => socket.end(response));
  });
  const port = await listen(server);
  const { desktop } = wire(port);
  const local = await desktop.open({
    listenerId: "listener",
    workspaceId: "workspace-a",
    port,
    localPort: 0,
  });
  const socket = net.connect({ host: "127.0.0.1", port: local.localPort, allowHalfOpen: true });
  cleanup.push(() => socket.destroy());
  const chunks: Buffer[] = [];
  socket.on("data", (chunk) => {
    chunks.push(chunk);
    socket.pause();
    setTimeout(() => socket.resume(), 1);
  });
  const ended = once(socket, "end");
  socket.end(randomBytes(2 * 1024 * 1024));
  await ended;
  expect(uploaded).toBe(2 * 1024 * 1024);
  expect(Buffer.concat(chunks).equals(response)).toBe(true);
}, 15_000);

test("uses a free local port when the remote port is occupied locally, but respects explicit conflicts", async () => {
  const port = await listen(net.createServer());
  const { desktop } = wire(port);
  const local = await desktop.open({ listenerId: "listener", workspaceId: "workspace-a", port });
  expect(local.localPort).not.toBe(port);
  await expect(
    desktop.open({ listenerId: "fixed", workspaceId: "workspace-a", port, localPort: port }),
  ).rejects.toThrow(/EADDRINUSE/);
});

test("rejects unregistered targets and immediately closes daemon sockets on source disposal", async () => {
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    cleanup.push(() => socket.destroy());
  });
  const port = await listen(server);
  const { daemon, frames } = wire(port);
  daemon.receive({
    opcode: TunnelOpcode.Open,
    streamId: "denied",
    workspaceId: "workspace-b",
    port,
  });
  await turn();
  expect(frames).toContainEqual({
    opcode: TunnelOpcode.Close,
    streamId: "denied",
    reason: TunnelCloseReason.Forbidden,
  });
  daemon.receive({
    opcode: TunnelOpcode.Open,
    streamId: "allowed",
    workspaceId: "workspace-a",
    port,
  });
  await expect.poll(() => sockets.size).toBe(1);
  daemon.dispose();
  await expect.poll(() => sockets.size).toBe(0);
});

test("caps unacknowledged download bytes until the client grants more credit", async () => {
  const server = net.createServer((socket) => {
    cleanup.push(() => socket.destroy());
    socket.on("error", () => {});
    socket.write(Buffer.alloc(2 * TUNNEL_WINDOW_BYTES, 7));
  });
  const port = await listen(server);
  const frames: TunnelFrame[] = [];
  const tunnel = new WorkspaceTunnel({
    authorizeTarget: async () => true,
    send: async (frame) => {
      frames.push(frame);
    },
  });
  cleanup.push(() => tunnel.dispose());
  const bytesSent = () =>
    frames.reduce(
      (total, frame) => total + (frame.opcode === TunnelOpcode.Data ? frame.payload.length : 0),
      0,
    );
  tunnel.receive({ opcode: TunnelOpcode.Open, streamId: "slow", workspaceId: "ws", port });
  await expect.poll(bytesSent).toBe(TUNNEL_WINDOW_BYTES);
  await turn();
  expect(bytesSent()).toBe(TUNNEL_WINDOW_BYTES);
  tunnel.receive({ opcode: TunnelOpcode.Credit, streamId: "slow", bytes: 1 });
  await expect.poll(bytesSent).toBe(TUNNEL_WINDOW_BYTES + 1);
});

test("accepts the peer's first request while Opened is still completing", async () => {
  const server = net.createServer((socket) => {
    cleanup.push(() => socket.destroy());
    socket.on("data", (chunk) => socket.write(chunk));
  });
  const port = await listen(server);
  const frames: TunnelFrame[] = [];
  const tunnel = new WorkspaceTunnel({
    authorizeTarget: async () => true,
    send: async (frame) => {
      frames.push(frame);
      if (frame.opcode === TunnelOpcode.Opened) {
        tunnel.receive({
          opcode: TunnelOpcode.Data,
          streamId: frame.streamId,
          payload: Buffer.from("immediate"),
        });
        await turn();
      }
    },
  });
  cleanup.push(() => tunnel.dispose());
  tunnel.receive({ opcode: TunnelOpcode.Open, streamId: "quick", workspaceId: "ws", port });
  await expect
    .poll(() =>
      frames
        .filter((frame) => frame.opcode === TunnelOpcode.Data)
        .map((frame) => Buffer.from(frame.payload).toString()),
    )
    .toEqual(["immediate"]);
  expect(frames.filter((frame) => frame.opcode === TunnelOpcode.Close)).toEqual([]);
});

test("carries HTTP through the existing encrypted relay channel without exposing request bytes", async () => {
  const service = http.createServer((request, response) => request.pipe(response));
  cleanup.push(() => service.closeAllConnections());
  const port = await listen(service);
  const ciphertext: ArrayBuffer[] = [];
  const daemonTransport: Transport = {
    send: async (data) => {
      if (typeof data !== "string") ciphertext.push(data);
      await turn();
      clientTransport.onmessage?.({ data, isBinary: typeof data !== "string" });
    },
    close: () => {},
    onmessage: null,
    onclose: null,
    onerror: null,
  };
  const clientTransport: Transport = {
    send: async (data) => {
      if (typeof data !== "string") ciphertext.push(data);
      await turn();
      daemonTransport.onmessage?.({ data, isBinary: typeof data !== "string" });
    },
    close: () => {},
    onmessage: null,
    onclose: null,
    onerror: null,
  };
  const keys = generateKeyPair();
  const daemonOpening = createDaemonChannel(daemonTransport, keys, {
    onmessage: (data) => {
      if (typeof data !== "string") {
        const frame = decodeTunnelFrame(new Uint8Array(data));
        if (frame) tunnel.receive(frame);
      }
    },
  });
  const clientChannel = await createClientChannel(
    clientTransport,
    exportPublicKey(keys.publicKey),
    {
      onmessage: (data) => {
        if (typeof data !== "string") {
          const frame = decodeTunnelFrame(new Uint8Array(data));
          if (frame) desktop.receive("encrypted", frame);
        }
      },
    },
  );
  const daemonChannel = await daemonOpening;
  const desktop = new PortForwarding(async (_id, frame) =>
    clientChannel.send(new Uint8Array(encodeTunnelFrame(frame)).buffer),
  );
  const tunnel = new WorkspaceTunnel({
    authorizeTarget: async (_workspace, target) => target === port,
    send: async (frame) => daemonChannel.send(new Uint8Array(encodeTunnelFrame(frame)).buffer),
  });
  cleanup.push(() => {
    desktop.dispose();
    tunnel.dispose();
    clientChannel.close();
    daemonChannel.close();
  });
  const local = await desktop.open({
    listenerId: "encrypted",
    workspaceId: "private-workspace",
    port,
    localPort: 0,
  });
  const secret = "private-service-preview".repeat(10_000);
  const response = await fetch(`http://127.0.0.1:${local.localPort}/`, {
    method: "POST",
    body: secret,
    headers: { Connection: "close" },
  });
  expect(await response.text()).toBe(secret);
  expect(ciphertext.length).toBeGreaterThan(2);
  expect(ciphertext.some((packet) => Buffer.from(packet).includes("private-service-preview"))).toBe(
    false,
  );
});
