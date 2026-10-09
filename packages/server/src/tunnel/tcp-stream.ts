import type { Socket } from "node:net";
import {
  TUNNEL_CHUNK_BYTES,
  TUNNEL_WINDOW_BYTES,
  TunnelCloseReason,
  TunnelOpcode,
  type TunnelFrame,
} from "@getpaseo/protocol/binary-frames/index";

export interface TcpTunnelStreamOptions {
  streamId: string;
  socket: Socket;
  send: (frame: TunnelFrame) => Promise<void>;
  onClose: () => void;
}

/** Credit is returned after a socket write drains, bounding both relay directions. */
export class TcpTunnelStream {
  private credit = 0;
  private pendingWriteBytes = 0;
  private active = false;
  private readingEnabled = false;
  private closed = false;
  private sending = false;
  private remoteEnded = false;
  private localEnded = false;
  private endSent = false;
  private readonly options: TcpTunnelStreamOptions;

  constructor(options: TcpTunnelStreamOptions) {
    this.options = options;
    const { socket } = options;
    socket.setNoDelay(true);
    socket.on("readable", () => this.pump());
    socket.on("end", () => {
      this.localEnded = true;
      this.pump();
    });
    socket.on("error", () => this.close(TunnelCloseReason.Unavailable));
    socket.on("close", (hadError) => {
      if (!hadError && this.localEnded && this.remoteEnded) {
        // Preserve the final data and FIN already queued on the transport.
        if (!this.sending && this.endSent) this.dispose();
        else this.pump();
      } else {
        this.close(TunnelCloseReason.Closed);
      }
    });
  }

  activate(startReading = true): void {
    if (this.closed) return;
    if (this.active) {
      this.close(TunnelCloseReason.ProtocolError);
      return;
    }
    this.active = true;
    this.credit = TUNNEL_WINDOW_BYTES;
    this.readingEnabled = startReading;
    this.pump();
  }

  startReading(): void {
    this.readingEnabled = true;
    this.pump();
  }

  receive(frame: TunnelFrame): void {
    if (this.closed) return;
    if (frame.opcode === TunnelOpcode.Close) {
      this.dispose();
      return;
    }
    if (frame.opcode === TunnelOpcode.Opened) {
      this.activate();
      return;
    }
    if (!this.active) {
      this.close(TunnelCloseReason.ProtocolError);
      return;
    }
    switch (frame.opcode) {
      case TunnelOpcode.Credit:
        if (this.credit + frame.bytes > TUNNEL_WINDOW_BYTES) {
          this.close(TunnelCloseReason.ProtocolError);
          return;
        }
        this.credit += frame.bytes;
        this.pump();
        return;
      case TunnelOpcode.Data:
        this.write(frame.payload);
        return;
      case TunnelOpcode.End:
        if (this.remoteEnded) {
          this.close(TunnelCloseReason.ProtocolError);
          return;
        }
        this.remoteEnded = true;
        this.options.socket.end();
        return;
      default:
        this.close(TunnelCloseReason.ProtocolError);
    }
  }

  private write(payload: Uint8Array): void {
    const exceedsWindow = this.pendingWriteBytes + payload.length > TUNNEL_WINDOW_BYTES;
    if (this.remoteEnded || exceedsWindow) {
      this.close(TunnelCloseReason.ProtocolError);
      return;
    }
    this.pendingWriteBytes += payload.length;
    this.options.socket.write(payload, (error) => {
      this.pendingWriteBytes -= payload.length;
      if (this.closed) return;
      if (error) {
        this.close(TunnelCloseReason.Unavailable);
        return;
      }
      void this.send({
        opcode: TunnelOpcode.Credit,
        streamId: this.options.streamId,
        bytes: payload.length,
      });
    });
  }

  private pump(): void {
    if (this.closed || !this.active || !this.readingEnabled || this.sending) return;
    this.sending = true;
    void this.flush()
      .catch(() => this.close(TunnelCloseReason.Unavailable))
      .finally(() => {
        this.sending = false;
        if (this.endSent && this.remoteEnded && this.options.socket.destroyed) {
          this.dispose();
          return;
        }
        const canRead = this.credit > 0 && this.options.socket.readableLength > 0;
        const canEnd = this.localEnded && !this.endSent;
        if (!this.closed && (canRead || canEnd)) this.pump();
      });
  }

  private async flush(): Promise<void> {
    const { socket, streamId } = this.options;
    while (!this.closed && this.credit > 0) {
      const length = Math.min(socket.readableLength, this.credit, TUNNEL_CHUNK_BYTES);
      // read(0) allows Node to deliver EOF after the final buffered bytes.
      const chunk: unknown = socket.read(length);
      if (!(chunk instanceof Uint8Array) || chunk.length === 0) break;
      this.credit -= chunk.length;
      await this.send({ opcode: TunnelOpcode.Data, streamId, payload: chunk });
    }
    if (this.localEnded && !this.endSent && !this.closed) {
      this.endSent = true;
      await this.send({ opcode: TunnelOpcode.End, streamId });
    }
  }

  private async send(frame: TunnelFrame): Promise<void> {
    try {
      await this.options.send(frame);
    } catch {
      this.dispose();
    }
  }

  close(reason: number): void {
    if (this.closed) return;
    this.dispose();
    void this.send({ opcode: TunnelOpcode.Close, streamId: this.options.streamId, reason });
  }

  dispose(): void {
    if (this.closed) return;
    this.closed = true;
    this.options.socket.destroy();
    this.options.onClose();
  }
}
