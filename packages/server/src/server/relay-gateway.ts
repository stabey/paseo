import { createHash, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import type { Duplex } from "node:stream";
import type { Socket } from "node:net";
import type pino from "pino";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import { buildRelayWebSocketUrl } from "@getpaseo/protocol/daemon-endpoints";
import type { RelayGatewayConfig } from "./relay-gateway-config.js";
import type { RelayProxySelection } from "./relay-proxy.js";
import { createRelayWebSocketFactory } from "./relay-websocket.js";
import { MAX_PHYSICAL_SOCKET_BUFFERED_BYTES } from "./websocket/physical-socket.js";

export interface RelayGatewayStatus {
  listen: string;
  useTls: boolean;
  authorizedPeers: number;
  connections: number;
  pendingConnections: number;
  connectedPeers: string[];
}

export interface RelayGateway {
  getStatus(): RelayGatewayStatus;
  stop(): Promise<void>;
}

interface GatewayOptions {
  config: RelayGatewayConfig;
  serverId: string;
  relayEndpoint: string;
  relayUseTls: boolean;
  proxy?: RelayProxySelection | null;
  logger: pino.Logger;
}

interface Route {
  serverId: string;
  connectionId?: string;
}

const KEEPALIVE_INTERVAL_MS = 10_000;
const STALE_TIMEOUT_MS = 30_000;
const ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const QUERY_KEYS = new Set(["serverId", "role", "v", "connectionId"]);

/**
 * Only forwards daemon-side relay sockets to one configured upstream.
 * It never attaches downstream messages to the gateway daemon's own session
 * or terminates the downstream daemon's end-to-end encrypted channel.
 */
export async function startRelayGateway(options: GatewayOptions): Promise<RelayGateway> {
  const { config, logger } = options;
  // Fail startup on an invalid target, instead of throwing from an upgrade event.
  buildRelayWebSocketUrl({
    endpoint: options.relayEndpoint,
    useTls: options.relayUseTls,
    serverId: options.serverId,
    role: "server",
  });
  const peers = new Map(
    config.peers.map((peer) => [peer.serverId, Buffer.from(peer.tokenSha256, "hex")]),
  );
  if (peers.has(options.serverId)) {
    throw new Error("A relay gateway cannot authorize its own server ID");
  }
  const tlsOptions = config.tls
    ? {
        cert: await readFile(config.tls.certFile),
        key: await readFile(config.tls.keyFile),
      }
    : null;
  const server = tlsOptions ? createHttpsServer(tlsOptions) : createServer();
  server.headersTimeout = 10_000;
  server.requestTimeout = 10_000;
  server.keepAliveTimeout = 1_000;
  server.maxConnections = config.maxConnections + 16;
  const wss = new WebSocketServer({
    noServer: true,
    perMessageDeflate: false,
    maxPayload: MAX_PHYSICAL_SOCKET_BUFFERED_BYTES,
  });
  const rawSockets = new Set<Socket>();
  const connections = new Set<{
    serverId: string;
    ready: boolean;
    close(): void;
  }>();
  const dial = createRelayWebSocketFactory(options.proxy ?? null);
  let stopped = false;
  let stopPromise: Promise<void> | undefined;

  server.on("connection", (socket) => {
    rawSockets.add(socket);
    socket.once("close", () => rawSockets.delete(socket));
    socket.on("error", () => {});
    socket.setTimeout(10_000, () => socket.destroy());
  });
  server.on("request", (_req, res) => {
    res.writeHead(404, { Connection: "close" });
    res.end();
  });
  server.on("connect", (_req, socket) => reject(socket, 405));
  server.on("upgrade", (req, socket, head) => {
    const route = parseRoute(req);
    if (stopped) return reject(socket, 503);
    // This endpoint is for daemons, never a browser or arbitrary CONNECT proxy.
    if (!route || req.headers.origin !== undefined) return reject(socket, 400);
    if (!authorized(req, peers.get(route.serverId))) return reject(socket, 401);
    const peerConnections = [...connections].filter(
      (connection) => connection.serverId === route.serverId,
    ).length;
    if (
      connections.size >= config.maxConnections ||
      peerConnections >= config.maxConnectionsPerPeer
    ) {
      return reject(socket, 429);
    }

    // Rebuild the URL from validated routing fields. Never forward request headers,
    // credentials, or a caller-selected destination to the public relay.
    const url = buildRelayWebSocketUrl({
      endpoint: options.relayEndpoint,
      useTls: options.relayUseTls,
      serverId: route.serverId,
      role: "server",
      connectionId: route.connectionId,
      version: "2",
    });
    const channel = route.connectionId ? "data" : "control";
    let upstream: WebSocket;
    try {
      upstream = dial(url);
    } catch {
      return reject(socket, 502);
    }
    let downstream: WebSocket | null = null;
    let closed = false;
    let lastUpstreamActivity = Date.now();
    let lastDownstreamActivity = Date.now();
    let keepalive: ReturnType<typeof setInterval> | undefined;
    const entry = { serverId: route.serverId, ready: false, close };
    connections.add(entry);
    socket.once("close", close);
    socket.once("error", close);

    function close(): void {
      dispose();
    }

    function dispose(rejectionStatus?: number): void {
      if (closed) return;
      closed = true;
      clearInterval(keepalive);
      connections.delete(entry);
      upstream.terminate();
      downstream?.terminate();
      if (rejectionStatus && !downstream) reject(socket, rejectionStatus);
      else socket.destroy();
    }

    function forward(source: WebSocket, target: WebSocket, data: RawData, binary: boolean): void {
      const bytes = Array.isArray(data)
        ? data.reduce((sum, part) => sum + part.byteLength, 0)
        : data.byteLength;
      if (
        target.readyState !== WebSocket.OPEN ||
        target.bufferedAmount + bytes > MAX_PHYSICAL_SOCKET_BUFFERED_BYTES
      ) {
        close();
        return;
      }
      source.pause();
      target.send(data, { binary }, (error) => {
        if (error) close();
        else if (!closed) source.resume();
      });
    }

    upstream.on("error", () => {
      logger.warn({ serverId: route.serverId }, "relay_gateway_upstream_error");
      dispose(502);
    });
    upstream.on("unexpected-response", (_request, response) => {
      logger.warn(
        { serverId: route.serverId, statusCode: response.statusCode },
        "relay_gateway_upstream_rejected",
      );
      response.resume();
      dispose(502);
    });
    upstream.once("close", close);
    upstream.on("pong", () => {
      lastUpstreamActivity = Date.now();
    });
    upstream.on("message", (data, binary) => {
      lastUpstreamActivity = Date.now();
      if (downstream) forward(upstream, downstream, data, binary);
    });
    upstream.once("open", () => {
      if (closed || socket.destroyed) return close();
      try {
        wss.handleUpgrade(req, socket, head, attachDownstream);
      } catch {
        close();
      }
    });

    function attachDownstream(client: WebSocket): void {
      downstream = client;
      entry.ready = true;
      req.socket.setTimeout(0);
      lastUpstreamActivity = Date.now();
      lastDownstreamActivity = Date.now();
      client.on("error", close);
      client.once("close", close);
      client.on("pong", () => {
        lastDownstreamActivity = Date.now();
      });
      client.on("message", (data, binary) => {
        lastDownstreamActivity = Date.now();
        forward(client, upstream, data, binary);
      });
      // A local automatic pong must not hide a dead upstream from the daemon.
      keepalive = setInterval(() => {
        if (
          Date.now() - lastUpstreamActivity > STALE_TIMEOUT_MS ||
          Date.now() - lastDownstreamActivity > STALE_TIMEOUT_MS
        ) {
          close();
          return;
        }
        upstream.ping();
        client.ping();
      }, KEEPALIVE_INTERVAL_MS);
      keepalive.unref();
      logger.debug({ serverId: entry.serverId, channel }, "relay_gateway_connected");
    }
  });

  async function stop(): Promise<void> {
    if (stopPromise) return stopPromise;
    stopped = true;
    stopPromise = (async () => {
      for (const connection of connections) connection.close();
      for (const socket of rawSockets) socket.destroy();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await new Promise<void>((resolve) => server.close(() => resolve()));
    })();
    return stopPromise;
  }

  try {
    await new Promise<void>((resolve, rejectListen) => {
      server.once("error", rejectListen);
      server.listen(config.listen.port, config.listen.host, () => {
        server.off("error", rejectListen);
        resolve();
      });
    });
  } catch (error) {
    await stop();
    throw error;
  }
  server.on("error", () => logger.error("relay_gateway_listener_error"));
  const address = server.address();
  if (!address || typeof address === "string") {
    await stop();
    throw new Error("Relay gateway did not bind a TCP listener");
  }
  const host = address.address.includes(":") ? `[${address.address}]` : address.address;
  const listen = `${host}:${address.port}`;
  logger.info(
    { listen, useTls: !!tlsOptions, authorizedPeers: peers.size },
    "relay_gateway_listening",
  );
  return {
    stop,
    getStatus: () => ({
      listen,
      useTls: !!tlsOptions,
      authorizedPeers: peers.size,
      connections: [...connections].filter((connection) => connection.ready).length,
      pendingConnections: [...connections].filter((connection) => !connection.ready).length,
      connectedPeers: [...new Set([...connections].map((connection) => connection.serverId))],
    }),
  };
}

function parseRoute(req: IncomingMessage): Route | null {
  if (req.method !== "GET" || !req.url?.startsWith("/ws?") || req.url.length > 1024) return null;
  const url = new URL(req.url, "http://gateway.invalid");
  for (const key of url.searchParams.keys()) {
    if (!QUERY_KEYS.has(key) || url.searchParams.getAll(key).length !== 1) return null;
  }
  const serverId = url.searchParams.get("serverId");
  const connectionId = url.searchParams.get("connectionId");
  if (
    url.pathname !== "/ws" ||
    url.hash ||
    url.searchParams.get("role") !== "server" ||
    url.searchParams.get("v") !== "2" ||
    !serverId ||
    !ID_PATTERN.test(serverId) ||
    (connectionId !== null && !ID_PATTERN.test(connectionId))
  ) {
    return null;
  }
  return { serverId, ...(connectionId ? { connectionId } : {}) };
}

function authorized(req: IncomingMessage, expected: Buffer | undefined): boolean {
  const header = req.headers.authorization;
  if (!expected || !header || !/^Bearer [A-Za-z0-9_-]{43,128}$/.test(header)) return false;
  const actual = createHash("sha256").update(header.slice(7)).digest();
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

function reject(socket: Duplex, status: number): void {
  if (!socket.destroyed) {
    socket.end(
      `HTTP/1.1 ${status} Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
      () => socket.destroy(),
    );
  }
}
