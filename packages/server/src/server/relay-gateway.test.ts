import { createHash, randomBytes } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import type { Socket } from "node:net";
import pino from "pino";
import { afterEach, expect, test, vi } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import { buildRelayWebSocketUrl } from "@getpaseo/protocol/daemon-endpoints";
import { startRelayGateway } from "./relay-gateway.js";
import { startRelayTransport } from "./relay-transport.js";
import {
  createGatewayTestProxy,
  createGatewayTestRelay,
  listenLoopback,
} from "./test-utils/relay-gateway.js";

const token = randomBytes(32).toString("base64url");
const tokenB = randomBytes(32).toString("base64url");
const peers = [
  { serverId: "srv_container_a", tokenSha256: sha256(token) },
  { serverId: "srv_container_b", tokenSha256: sha256(tokenB) },
];
const logger = pino({ level: "silent" });
const cleanups: Array<() => Promise<void>> = [];

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function url(endpoint: string, serverId = peers[0].serverId, connectionId?: string): string {
  return buildRelayWebSocketUrl({
    endpoint,
    useTls: false,
    serverId,
    connectionId,
    role: "server",
  });
}

async function rejected(urlValue: string, headers: Record<string, string> = {}): Promise<number> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(urlValue, { headers });
    ws.on("error", () => {});
    ws.once("open", () => {
      ws.terminate();
      reject(new Error("Unexpectedly accepted"));
    });
    ws.once("unexpected-response", (_req, response) => {
      response.resume();
      ws.terminate();
      resolve(response.statusCode!);
    });
  });
}

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
  vi.useRealTimers();
});

test("rejects unauthenticated peers, identity substitution and arbitrary routes before dialing", async () => {
  const relay = await createGatewayTestRelay();
  cleanups.push(relay.close);
  const gateway = await startRelayGateway({
    config: {
      listen: { host: "127.0.0.1", port: 0 },
      peers,
      maxConnections: 8,
      maxConnectionsPerPeer: 4,
    },
    serverId: "srv_windows",
    relayEndpoint: relay.endpoint,
    relayUseTls: false,
    logger,
  });
  cleanups.push(gateway.stop);
  const endpoint = gateway.getStatus().listen;
  const headers = { Authorization: `Bearer ${token}` };
  expect(await rejected(url(endpoint))).toBe(401);
  expect(await rejected(url(endpoint), { Authorization: `Bearer ${tokenB}` })).toBe(401);
  expect(await rejected(url(endpoint, peers[1].serverId), headers)).toBe(401);
  expect(await rejected(url(endpoint, "srv_windows"), headers)).toBe(401);
  expect(await rejected(url(endpoint), { ...headers, Origin: "http://evil.test" })).toBe(400);
  expect(await rejected(url(endpoint).replace("role=server", "role=client"), headers)).toBe(400);
  expect(await rejected(`${url(endpoint)}&target=http://other.test`, headers)).toBe(400);
  expect(await rejected(`${url(endpoint)}&serverId=other`, headers)).toBe(400);
  expect(await rejected(url(endpoint).replace("/ws?", "/other?"), headers)).toBe(400);
  expect(relay.requests).toHaveLength(0);
  expect(gateway.getStatus().connections).toBe(0);
});

test("forwards control and binary data through the configured CONNECT proxy without leaking credentials", async () => {
  const server = createServer();
  const wss = new WebSocketServer({ server });
  const requests: Array<{ url: string; authorization?: string }> = [];
  wss.on("connection", (ws, req) => {
    requests.push({ url: req.url!, authorization: req.headers.authorization });
    ws.on("message", (data, binary) => ws.send(data, { binary }));
  });
  const upstream = await listenLoopback(server);
  cleanups.push(async () => {
    for (const client of wss.clients) client.terminate();
    await new Promise<void>((resolve) => wss.close(() => resolve()));
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const proxy = await createGatewayTestProxy();
  cleanups.push(proxy.close);
  const gateway = await startRelayGateway({
    config: {
      listen: { host: "127.0.0.1", port: 0 },
      peers,
      maxConnections: 8,
      maxConnectionsPerPeer: 4,
    },
    serverId: "srv_windows",
    relayEndpoint: upstream,
    relayUseTls: false,
    proxy: { url: `http://${proxy.endpoint}`, source: "PASEO_RELAY_PROXY" },
    logger,
  });
  cleanups.push(gateway.stop);
  for (const connectionId of [undefined, "client_connection"]) {
    const ws = new WebSocket(url(gateway.getStatus().listen, peers[0].serverId, connectionId), {
      headers: { Authorization: `Bearer ${token}` },
    });
    ws.on("error", () => {});
    cleanups.push(async () => ws.terminate());
    await once(ws, "open");
    const textReply = once(ws, "message");
    ws.send('{"type":"sync","connectionIds":[]}');
    const [text, textIsBinary] = await textReply;
    expect(text.toString()).toBe('{"type":"sync","connectionIds":[]}');
    expect(textIsBinary).toBe(false);
    const payload = randomBytes(256 * 1024);
    const binaryReply = once(ws, "message");
    ws.send(payload);
    const [binary, binaryFlag] = await binaryReply;
    expect(binary).toEqual(payload);
    expect(binaryFlag).toBe(true);
  }
  expect(proxy.targets).toEqual([upstream, upstream]);
  expect(requests).toHaveLength(2);
  expect(requests.every((request) => request.authorization === undefined)).toBe(true);
  expect(requests[1].url).toContain("connectionId=client_connection");
  expect(gateway.getStatus()).toMatchObject({
    connections: 2,
    pendingConnections: 0,
    connectedPeers: [peers[0].serverId],
  });
  await gateway.stop();
  expect(gateway.getStatus().connections).toBe(0);
});

test("limits open and pending connections per peer and globally", async () => {
  const server = createServer();
  const sockets = new Set<Socket>();
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  server.on("upgrade", (_req, socket) => {
    // Never complete the handshake, but drain EOF so the fixture observes aborts.
    socket.on("end", () => socket.destroy());
    socket.resume();
  });
  const upstream = await listenLoopback(server);
  cleanups.push(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const gateway = await startRelayGateway({
    config: {
      listen: { host: "127.0.0.1", port: 0 },
      peers,
      maxConnections: 2,
      maxConnectionsPerPeer: 1,
    },
    serverId: "srv_windows",
    relayEndpoint: upstream,
    relayUseTls: false,
    logger,
  });
  cleanups.push(gateway.stop);
  for (const [id, credential] of [
    [peers[0].serverId, token],
    [peers[1].serverId, tokenB],
  ]) {
    const ws = new WebSocket(url(gateway.getStatus().listen, id), {
      headers: { Authorization: `Bearer ${credential}` },
    });
    ws.on("error", () => {});
    cleanups.push(async () => ws.terminate());
    await vi.waitFor(() => expect(gateway.getStatus().connectedPeers).toContain(id));
    expect(
      await rejected(url(gateway.getStatus().listen, id, "extra"), {
        Authorization: `Bearer ${credential}`,
      }),
    ).toBe(429);
  }
  expect(gateway.getStatus().pendingConnections).toBe(2);
  await gateway.stop();
  expect(gateway.getStatus().pendingConnections).toBe(0);
  await vi.waitFor(() => expect(sockets.size).toBe(0));
});

test("drops downstream on upstream loss and lets the real relay transport reconnect", async () => {
  const relay = await createGatewayTestRelay();
  cleanups.push(relay.close);
  const gateway = await startRelayGateway({
    config: {
      listen: { host: "127.0.0.1", port: 0 },
      peers,
      maxConnections: 8,
      maxConnectionsPerPeer: 4,
    },
    serverId: "srv_windows",
    relayEndpoint: relay.endpoint,
    relayUseTls: false,
    logger,
  });
  cleanups.push(gateway.stop);
  const transport = startRelayTransport({
    logger,
    relayEndpoint: gateway.getStatus().listen,
    relayUseTls: false,
    serverId: peers[0].serverId,
    gatewayToken: token,
    attachSocket: async () => {},
  });
  cleanups.push(transport.stop);
  await vi.waitFor(() => expect(relay.controls.has(peers[0].serverId)).toBe(true));
  relay.disconnect();
  await vi.waitFor(() => expect(relay.requests.length).toBeGreaterThanOrEqual(2), {
    timeout: 4000,
  });
  expect(relay.controls.has(peers[0].serverId)).toBe(true);
  expect(gateway.getStatus().connections).toBe(1);
});

test("reports an upstream proxy authentication rejection and releases the pending slot", async () => {
  const proxy = createServer();
  proxy.on("connect", (_req, socket) => {
    socket.end("HTTP/1.1 407 Proxy Authentication Required\r\nContent-Length: 0\r\n\r\n");
  });
  const endpoint = await listenLoopback(proxy);
  cleanups.push(async () => {
    await new Promise<void>((resolve) => proxy.close(() => resolve()));
  });
  const gateway = await startRelayGateway({
    config: {
      listen: { host: "127.0.0.1", port: 0 },
      peers,
      maxConnections: 8,
      maxConnectionsPerPeer: 4,
    },
    serverId: "srv_windows",
    relayEndpoint: "unreachable-relay.test:443",
    relayUseTls: true,
    proxy: { url: `http://${endpoint}`, source: "PASEO_RELAY_PROXY" },
    logger,
  });
  cleanups.push(gateway.stop);
  expect(
    await rejected(url(gateway.getStatus().listen), { Authorization: `Bearer ${token}` }),
  ).toBe(502);
  expect(gateway.getStatus().pendingConnections).toBe(0);
});

test("a local pong does not keep a downstream connected to a silent upstream", async () => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
  const server = createServer();
  const wss = new WebSocketServer({ server, autoPong: false });
  const endpoint = await listenLoopback(server);
  cleanups.push(async () => {
    for (const client of wss.clients) client.terminate();
    await new Promise<void>((resolve) => wss.close(() => resolve()));
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const gateway = await startRelayGateway({
    config: {
      listen: { host: "127.0.0.1", port: 0 },
      peers,
      maxConnections: 8,
      maxConnectionsPerPeer: 4,
    },
    serverId: "srv_windows",
    relayEndpoint: endpoint,
    relayUseTls: false,
    logger,
  });
  cleanups.push(gateway.stop);
  const ws = new WebSocket(url(gateway.getStatus().listen), {
    headers: { Authorization: `Bearer ${token}` },
  });
  ws.on("error", () => {});
  cleanups.push(async () => ws.terminate());
  await once(ws, "open");
  const closed = once(ws, "close");
  await vi.advanceTimersByTimeAsync(40_001);
  await closed;
  expect(gateway.getStatus().connections).toBe(0);
});

test("invalid upstream configuration fails before binding and a gateway cannot authorize itself", async () => {
  const options = {
    config: {
      listen: { host: "127.0.0.1", port: 0 },
      peers,
      maxConnections: 8,
      maxConnectionsPerPeer: 4,
    },
    serverId: "srv_windows",
    relayEndpoint: "not-a-host-port",
    relayUseTls: false,
    logger,
  };
  await expect(startRelayGateway(options)).rejects.toThrow(/host:port/);
  await expect(
    startRelayGateway({
      ...options,
      relayEndpoint: "relay.test:443",
      serverId: peers[0].serverId,
    }),
  ).rejects.toThrow(/own server ID/);
});
