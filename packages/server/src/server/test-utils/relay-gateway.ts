import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { connect, type Socket } from "node:net";
import { WebSocket, WebSocketServer, type RawData } from "ws";

export async function listenLoopback(server: Server): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No TCP address");
  return `127.0.0.1:${address.port}`;
}

/** Local relay protocol fixture. Crypto, daemon sessions and client SDK stay real. */
export async function createGatewayTestRelay() {
  const server = createServer();
  const wss = new WebSocketServer({ server });
  const requests: IncomingMessage[] = [];
  const controls = new Map<string, WebSocket>();
  const pairs = new Map<
    string,
    {
      serverId: string;
      client: WebSocket;
      daemon?: WebSocket;
      pending: Array<{ data: RawData; binary: boolean }>;
    }
  >();
  wss.on("connection", (socket, req) => {
    requests.push(req);
    socket.on("error", () => {});
    const url = new URL(req.url!, "http://relay.test");
    const serverId = url.searchParams.get("serverId")!;
    const connectionId = url.searchParams.get("connectionId");
    if (url.searchParams.get("role") === "server" && !connectionId) {
      controls.get(serverId)?.terminate();
      controls.set(serverId, socket);
      socket.send(
        JSON.stringify({
          type: "sync",
          connectionIds: [...pairs]
            .filter(([, pair]) => pair.serverId === serverId)
            .map(([id]) => id),
        }),
      );
      socket.on("close", () => {
        if (controls.get(serverId) === socket) controls.delete(serverId);
      });
      return;
    }
    if (url.searchParams.get("role") === "server" && connectionId) {
      const pair = pairs.get(connectionId);
      if (!pair || pair.serverId !== serverId) return socket.terminate();
      pair.daemon = socket;
      for (const frame of pair.pending) socket.send(frame.data, { binary: frame.binary });
      pair.pending = [];
      socket.on("message", (data, binary) => {
        if (pair.client.readyState === WebSocket.OPEN) pair.client.send(data, { binary });
      });
      socket.on("close", () => pair.client.terminate());
      return;
    }
    const id = randomUUID();
    const pair = {
      serverId,
      client: socket,
      pending: [] as Array<{ data: RawData; binary: boolean }>,
      daemon: undefined as WebSocket | undefined,
    };
    pairs.set(id, pair);
    socket.on("message", (data, binary) => {
      if (pair.daemon?.readyState === WebSocket.OPEN) pair.daemon.send(data, { binary });
      else pair.pending.push({ data, binary });
    });
    socket.on("close", () => {
      pair.daemon?.terminate();
      pairs.delete(id);
      const control = controls.get(serverId);
      if (control?.readyState === WebSocket.OPEN) {
        control.send(JSON.stringify({ type: "disconnected", connectionId: id }));
      }
    });
    controls.get(serverId)?.send(JSON.stringify({ type: "connected", connectionId: id }));
  });
  const endpoint = await listenLoopback(server);
  return {
    endpoint,
    requests,
    controls,
    pairs,
    disconnect: () => {
      for (const socket of wss.clients) socket.terminate();
    },
    close: async () => {
      for (const socket of wss.clients) socket.terminate();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

export async function createGatewayTestProxy() {
  const server = createServer();
  const sockets = new Set<Socket>();
  const targets: string[] = [];
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("error", () => {});
    socket.on("close", () => sockets.delete(socket));
  });
  server.on("connect", (req, downstream: Socket, head) => {
    targets.push(req.url!);
    const [host, port] = req.url!.split(":");
    const upstream = connect(Number(port), host, () => {
      downstream.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) upstream.write(head);
      upstream.pipe(downstream);
      downstream.pipe(upstream);
    });
    sockets.add(upstream);
    upstream.on("error", () => downstream.destroy());
    upstream.on("close", () => {
      sockets.delete(upstream);
      downstream.destroy();
    });
    downstream.on("close", () => upstream.destroy());
  });
  const endpoint = await listenLoopback(server);
  return {
    endpoint,
    targets,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
