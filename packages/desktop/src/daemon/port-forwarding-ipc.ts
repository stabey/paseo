import type { IpcMainInvokeEvent, WebContents } from "electron";
import { z } from "zod";
import { decodeTunnelFrame, encodeTunnelFrame } from "@getpaseo/protocol/binary-frames/tunnel";
import { PortForwarding } from "./port-forwarding.js";

const instances = new Map<WebContents, PortForwarding>();
const ListenerSchema = z.object({ listenerId: z.string().min(1).max(255) });
const OpenSchema = ListenerSchema.extend({
  workspaceId: z.string().min(1).max(1024),
  port: z.number().int().min(1).max(65535),
  localPort: z.number().int().min(0).max(65535).optional(),
});
const FrameSchema = ListenerSchema.extend({ frame: z.instanceof(Uint8Array) });

function getInstance(owner: WebContents): PortForwarding {
  const existing = instances.get(owner);
  if (existing) return existing;
  const forwarding = new PortForwarding(async (listenerId, frame) => {
    if (owner.isDestroyed()) throw new Error("Port forwarding window is closed");
    owner.send("paseo:event:port-forwarding", { listenerId, frame: encodeTunnelFrame(frame) });
  });
  instances.set(owner, forwarding);
  const dispose = () => {
    instances.delete(owner);
    forwarding.dispose();
    owner.removeListener("destroyed", dispose);
    owner.removeListener("render-process-gone", dispose);
    owner.removeListener("did-start-navigation", onNavigate);
  };
  const onNavigate = (
    _event: Electron.Event,
    _url: string,
    inPlace: boolean,
    isMainFrame: boolean,
  ) => {
    if (isMainFrame && !inPlace) dispose();
  };
  owner.once("destroyed", dispose);
  owner.once("render-process-gone", dispose);
  owner.on("did-start-navigation", onNavigate);
  return forwarding;
}

export async function invokePortForwarding(
  event: IpcMainInvokeEvent,
  command: string,
  args: unknown,
): Promise<unknown> {
  if (event.senderFrame !== event.sender.mainFrame)
    throw new Error("Port forwarding requires the app window");
  const forwarding = getInstance(event.sender);
  switch (command) {
    case "port_forwarding_open":
      return forwarding.open(OpenSchema.parse(args));
    case "port_forwarding_receive": {
      const input = FrameSchema.parse(args);
      const frame = decodeTunnelFrame(input.frame);
      if (!frame) throw new Error("Invalid tunnel frame");
      forwarding.receive(input.listenerId, frame);
      return;
    }
    case "port_forwarding_close":
      forwarding.close(ListenerSchema.parse(args).listenerId);
      return;
    default:
      throw new Error(`Unknown port forwarding command: ${command}`);
  }
}
