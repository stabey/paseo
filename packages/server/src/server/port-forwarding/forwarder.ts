import net from "node:net";
import {
  TUNNEL_STREAM_LIMIT,
  TunnelCloseReason,
  TunnelOpcode,
  type TunnelFrame,
} from "@getpaseo/protocol/binary-frames/index";
import { TcpTunnelStream } from "../../tunnel/tcp-stream.js";

interface TargetStream {
  workspaceId: string;
  port: number;
  stream: TcpTunnelStream | null;
  timer: ReturnType<typeof setTimeout> | null;
}

interface WorkspaceTunnelOptions {
  authorizeTarget: (workspaceId: string, port: number) => Promise<boolean>;
  send: (frame: TunnelFrame) => Promise<void>;
}

/** One physical client connection owns these sockets; they never survive a reconnect. */
export class WorkspaceTunnel {
  private readonly streams = new Map<string, TargetStream>();
  private disposed = false;

  constructor(private readonly options: WorkspaceTunnelOptions) {}

  receive(frame: TunnelFrame): void {
    if (this.disposed) return;
    if (frame.opcode === TunnelOpcode.Open) {
      void this.open(frame);
      return;
    }
    const entry = this.streams.get(frame.streamId);
    if (!entry) return;
    if (frame.opcode === TunnelOpcode.Close) {
      this.remove(frame.streamId);
    } else if (!entry.stream || frame.opcode === TunnelOpcode.Opened) {
      this.reject(frame.streamId, TunnelCloseReason.ProtocolError);
    } else {
      entry.stream.receive(frame);
    }
  }

  private async open(frame: Extract<TunnelFrame, { opcode: typeof TunnelOpcode.Open }>) {
    const { streamId, workspaceId, port } = frame;
    if (this.streams.has(streamId)) {
      this.reject(streamId, TunnelCloseReason.ProtocolError);
      return;
    }
    if (this.streams.size >= TUNNEL_STREAM_LIMIT) {
      this.reject(streamId, TunnelCloseReason.LimitExceeded);
      return;
    }
    const entry: TargetStream = { workspaceId, port, stream: null, timer: null };
    this.streams.set(streamId, entry);
    entry.timer = setTimeout(() => this.reject(streamId, TunnelCloseReason.Unavailable), 10_000);
    try {
      const allowed = await this.options.authorizeTarget(workspaceId, port);
      if (this.streams.get(streamId) !== entry) return;
      if (!allowed) {
        this.reject(streamId, TunnelCloseReason.Forbidden);
        return;
      }
      const socket = net.createConnection({ host: "127.0.0.1", port, allowHalfOpen: true });
      entry.stream = new TcpTunnelStream({
        streamId,
        socket,
        send: (message) => this.options.send(message),
        onClose: () => this.remove(streamId),
      });
      socket.once("connect", () => {
        void this.connected(streamId, entry);
      });
    } catch {
      if (this.streams.get(streamId) === entry)
        this.reject(streamId, TunnelCloseReason.Unavailable);
    }
  }

  private async connected(streamId: string, entry: TargetStream): Promise<void> {
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = null;
    try {
      // The peer may send data before the Opened send promise completes (notably via Electron IPC).
      // Accept writes now, but do not send a server greeting ahead of the acknowledgement.
      entry.stream?.activate(false);
      await this.options.send({ opcode: TunnelOpcode.Opened, streamId });
      if (this.streams.get(streamId) === entry) entry.stream?.startReading();
    } catch {
      this.remove(streamId);
    }
  }

  async revalidate(workspaceId: string): Promise<void> {
    for (const [id, entry] of this.streams) {
      if (entry.workspaceId !== workspaceId) continue;
      const allowed = await this.options
        .authorizeTarget(workspaceId, entry.port)
        .catch(() => false);
      if (!allowed && this.streams.get(id) === entry) this.reject(id, TunnelCloseReason.Forbidden);
    }
  }

  private reject(streamId: string, reason: number): void {
    this.remove(streamId);
    void this.options
      .send({ opcode: TunnelOpcode.Close, streamId, reason })
      .catch(() => this.dispose());
  }

  private remove(streamId: string): void {
    const entry = this.streams.get(streamId);
    if (!entry) return;
    this.streams.delete(streamId);
    if (entry.timer) clearTimeout(entry.timer);
    entry.stream?.dispose();
  }

  dispose(): void {
    this.disposed = true;
    for (const id of this.streams.keys()) this.remove(id);
  }

  revoke(): void {
    for (const id of this.streams.keys()) this.reject(id, TunnelCloseReason.Forbidden);
    this.disposed = true;
  }
}
