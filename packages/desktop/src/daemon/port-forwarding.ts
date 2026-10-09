import net, { type Server } from "node:net";
import { randomUUID } from "node:crypto";
import { TcpTunnelStream } from "@getpaseo/server/tcp-tunnel";
import {
  TUNNEL_STREAM_LIMIT,
  TunnelCloseReason,
  TunnelOpcode,
  type TunnelFrame,
} from "@getpaseo/protocol/binary-frames/index";

export interface LocalPortForward {
  listenerId: string;
  workspaceId: string;
  port: number;
  localPort?: number;
}

interface Listener {
  server: Server;
  localPort: number;
  streams: Map<string, TcpTunnelStream>;
}

export class PortForwarding {
  private readonly listeners = new Map<string, Listener>();
  private readonly opening = new Set<string>();
  private disposed = false;

  constructor(private readonly send: (listenerId: string, frame: TunnelFrame) => Promise<void>) {}

  async open(input: LocalPortForward): Promise<{ listenerId: string; localPort: number }> {
    if (this.disposed) throw new Error("Port forwarding window is closed");
    if (this.listeners.has(input.listenerId) || this.opening.has(input.listenerId)) {
      throw new Error("Port forwarding listener already exists");
    }
    if (this.listeners.size + this.opening.size >= TUNNEL_STREAM_LIMIT) {
      throw new Error("Too many forwarded ports in this window");
    }
    this.opening.add(input.listenerId);
    const listener: Listener = {
      server: net.createServer({ allowHalfOpen: true, pauseOnConnect: true }),
      localPort: 0,
      streams: new Map(),
    };
    listener.server.on("connection", (socket) => this.accept(input, listener, socket));
    try {
      try {
        await this.listen(listener.server, input.localPort ?? input.port);
      } catch (error) {
        const occupied = error instanceof Error && "code" in error && error.code === "EADDRINUSE";
        if (!occupied || input.localPort !== undefined) throw error;
        await this.listen(listener.server, 0);
      }
      if (this.disposed || !this.opening.has(input.listenerId)) {
        listener.server.close();
        throw new Error("Port forwarding was cancelled");
      }
      const address = listener.server.address();
      if (!address || typeof address === "string") throw new Error("No local forwarding address");
      listener.localPort = address.port;
      this.listeners.set(input.listenerId, listener);
      listener.server.on("error", () => this.close(input.listenerId));
      return { listenerId: input.listenerId, localPort: listener.localPort };
    } finally {
      this.opening.delete(input.listenerId);
    }
  }

  private listen(server: Server, port: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const onError = (error: Error) => reject(error);
      server.once("error", onError);
      server.listen(port, "127.0.0.1", () => {
        server.removeListener("error", onError);
        resolve();
      });
    });
  }

  private accept(input: LocalPortForward, listener: Listener, socket: net.Socket): void {
    if (this.disposed || listener.streams.size >= TUNNEL_STREAM_LIMIT) {
      socket.destroy();
      return;
    }
    const streamId = randomUUID();
    const timer = setTimeout(() => stream.close(TunnelCloseReason.Unavailable), 15_000);
    const stream = new TcpTunnelStream({
      streamId,
      socket,
      send: (frame) => this.send(input.listenerId, frame),
      onClose: () => {
        clearTimeout(timer);
        this.connectDeadlines.delete(streamId);
        listener.streams.delete(streamId);
      },
    });
    listener.streams.set(streamId, stream);
    // Connected idle streams stay valid until the socket or its owning connection closes.
    this.connectDeadlines.set(streamId, timer);
    void this.send(input.listenerId, {
      opcode: TunnelOpcode.Open,
      streamId,
      workspaceId: input.workspaceId,
      port: input.port,
    }).catch(() => stream.dispose());
  }

  private readonly connectDeadlines = new Map<string, ReturnType<typeof setTimeout>>();

  receive(listenerId: string, frame: TunnelFrame): void {
    const listener = this.listeners.get(listenerId);
    const stream = listener?.streams.get(frame.streamId);
    if (!stream) return;
    const timer = this.connectDeadlines.get(frame.streamId);
    if (timer) {
      clearTimeout(timer);
      this.connectDeadlines.delete(frame.streamId);
    }
    if (frame.opcode === TunnelOpcode.Open) {
      stream.close(TunnelCloseReason.ProtocolError);
      return;
    }
    stream.receive(frame);
  }

  close(listenerId: string): void {
    this.opening.delete(listenerId);
    const listener = this.listeners.get(listenerId);
    if (!listener) return;
    this.listeners.delete(listenerId);
    for (const stream of listener.streams.values()) stream.close(TunnelCloseReason.Closed);
    listener.server.close();
  }

  dispose(): void {
    this.disposed = true;
    this.opening.clear();
    for (const id of this.listeners.keys()) this.close(id);
    for (const timer of this.connectDeadlines.values()) clearTimeout(timer);
    this.connectDeadlines.clear();
  }
}
