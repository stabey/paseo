import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import {
  TunnelCloseReason,
  TunnelOpcode,
  type TunnelFrame,
} from "@getpaseo/protocol/binary-frames/index";

export interface ForwardedPort {
  workspaceId: string;
  port: number;
  listenerId: string;
  status: "connecting" | "forwarding" | "error";
  localPort?: number;
  requestedLocalPort?: number;
  error?: string;
}

export interface PortForwardingBridge {
  open(input: {
    listenerId: string;
    workspaceId: string;
    port: number;
    localPort?: number;
  }): Promise<{ localPort: number }>;
  close(listenerId: string): Promise<void>;
  receive(listenerId: string, frame: TunnelFrame): Promise<void>;
  listen(handler: (listenerId: string, frame: TunnelFrame) => void): Promise<() => void>;
}

export type TunnelClient = Pick<
  DaemonClient,
  | "isConnected"
  | "probeWorkspacePort"
  | "onTunnelFrame"
  | "sendTunnelFrame"
  | "subscribeConnectionStatus"
>;

interface StreamOwner {
  listenerId: string;
  localEnded: boolean;
  remoteEnded: boolean;
}

/** The desktop listener belongs to this live daemon connection, never to a saved host address. */
export class PortForwardingController {
  private records: readonly ForwardedPort[] = [];
  private readonly observers = new Set<() => void>();
  private readonly streams = new Map<string, StreamOwner>();
  private readonly pending = new Map<string, Promise<ForwardedPort>>();
  private listening: Promise<void> | null = null;
  private unlisten: (() => void) | null = null;
  private epoch = 0;

  constructor(
    private readonly client: TunnelClient,
    private readonly bridge: PortForwardingBridge,
  ) {
    client.onTunnelFrame((frame) => {
      const owner = this.streams.get(frame.streamId);
      if (!owner) return;
      if (frame.opcode === TunnelOpcode.Close && frame.reason === TunnelCloseReason.Forbidden) {
        this.fail(owner.listenerId, new Error("Port forwarding permission or target was removed."));
        return;
      }
      if (frame.opcode === TunnelOpcode.End) owner.remoteEnded = true;
      void bridge
        .receive(owner.listenerId, frame)
        .catch((error: unknown) => this.fail(owner.listenerId, error));
      if (frame.opcode === TunnelOpcode.Close || (owner.localEnded && owner.remoteEnded))
        this.streams.delete(frame.streamId);
    });
    client.subscribeConnectionStatus((state) => {
      if (state.status === "connected") return;
      this.epoch += 1;
      for (const record of this.records) {
        if (record.status !== "error")
          this.fail(
            record.listenerId,
            new Error("Host disconnected. Reconnect and retry forwarding."),
          );
      }
      this.streams.clear();
      this.unlisten?.();
      this.unlisten = null;
      this.listening = null;
    });
  }

  getState = (): readonly ForwardedPort[] => this.records;
  subscribe = (observer: () => void): (() => void) => {
    this.observers.add(observer);
    return () => this.observers.delete(observer);
  };

  private publish(record: ForwardedPort): void {
    this.records = [
      ...this.records.filter(
        (item) => item.workspaceId !== record.workspaceId || item.port !== record.port,
      ),
      record,
    ];
    for (const observer of this.observers) observer();
  }

  private async listen(): Promise<void> {
    if (!this.listening) {
      const epoch = this.epoch;
      this.listening = this.bridge
        .listen((listenerId, frame) => {
          // Browsers can reconnect as soon as main binds, before the open IPC reply arrives.
          if (
            !this.records.some(
              (record) => record.listenerId === listenerId && record.status !== "error",
            )
          )
            return;
          try {
            if (frame.opcode === TunnelOpcode.Open)
              this.streams.set(frame.streamId, {
                listenerId,
                localEnded: false,
                remoteEnded: false,
              });
            this.client.sendTunnelFrame(frame);
            const owner = this.streams.get(frame.streamId);
            if (owner && frame.opcode === TunnelOpcode.End) owner.localEnded = true;
            if (frame.opcode === TunnelOpcode.Close || (owner?.localEnded && owner.remoteEnded))
              this.streams.delete(frame.streamId);
          } catch (error) {
            this.fail(listenerId, error);
          }
        })
        .then((unlisten) => {
          if (epoch !== this.epoch) {
            unlisten();
            throw new Error("Host disconnected while starting forwarding");
          }
          this.unlisten = unlisten;
          return undefined;
        })
        .catch((error: unknown) => {
          this.listening = null;
          throw error;
        });
    }
    await this.listening;
  }

  start(input: { workspaceId: string; port: number; localPort?: number }): Promise<ForwardedPort> {
    const key = JSON.stringify([input.workspaceId, input.port]);
    const pending = this.pending.get(key);
    if (pending) return pending;
    const active = this.records.find(
      (record) =>
        record.workspaceId === input.workspaceId &&
        record.port === input.port &&
        record.status === "forwarding",
    );
    if (active) return Promise.resolve(active);
    const previous = this.records.find(
      (record) => record.workspaceId === input.workspaceId && record.port === input.port,
    );
    const promise = this.open({
      ...input,
      localPort: input.localPort ?? previous?.requestedLocalPort,
    }).finally(() => this.pending.delete(key));
    this.pending.set(key, promise);
    return promise;
  }

  private async open(input: {
    workspaceId: string;
    port: number;
    localPort?: number;
  }): Promise<ForwardedPort> {
    const record: ForwardedPort = {
      workspaceId: input.workspaceId,
      port: input.port,
      requestedLocalPort: input.localPort,
      listenerId: globalThis.crypto.randomUUID(),
      status: "connecting",
    };
    this.publish(record);
    const epoch = this.epoch;
    try {
      if (!this.client.isConnected) throw new Error("Host is disconnected");
      await this.listen();
      await this.client.probeWorkspacePort(input);
      const isCurrent = () => epoch === this.epoch && this.records.some((item) => item === record);
      if (!isCurrent()) throw new Error("Port forwarding was cancelled");
      const { localPort } = await this.bridge.open({ ...input, listenerId: record.listenerId });
      if (!isCurrent()) {
        await this.bridge.close(record.listenerId);
        throw new Error("Port forwarding was cancelled");
      }
      const active: ForwardedPort = { ...record, localPort, status: "forwarding" };
      this.publish(active);
      return active;
    } catch (error) {
      this.fail(record.listenerId, error);
      throw error;
    }
  }

  async stop(workspaceId: string, port: number): Promise<void> {
    const record = this.records.find(
      (item) => item.workspaceId === workspaceId && item.port === port,
    );
    if (!record) return;
    // Keep the record until main has sent Close for its sockets, so the daemon sees those frames.
    await this.bridge.close(record.listenerId);
    this.records = this.records.filter((item) => item.listenerId !== record.listenerId);
    this.clearStreams(record.listenerId);
    for (const observer of this.observers) observer();
  }

  private clearStreams(listenerId: string): void {
    for (const [id, owner] of this.streams) {
      if (owner.listenerId !== listenerId) continue;
      this.streams.delete(id);
      try {
        if (this.client.isConnected)
          this.client.sendTunnelFrame({
            opcode: TunnelOpcode.Close,
            streamId: id,
            reason: TunnelCloseReason.Closed,
          });
      } catch {
        // Source disconnection also disposes all daemon sockets.
      }
    }
  }

  private fail(listenerId: string, error: unknown): void {
    const record = this.records.find((item) => item.listenerId === listenerId);
    if (!record) return;
    this.publish({
      ...record,
      status: "error",
      error: error instanceof Error ? error.message : String(error),
    });
    this.clearStreams(listenerId);
    void this.bridge.close(listenerId).catch(() => {});
  }
}
