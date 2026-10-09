import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { decodeTunnelFrame, encodeTunnelFrame } from "@getpaseo/protocol/binary-frames/index";
import { invokeDesktopCommand } from "@/desktop/electron/invoke";
import { listenToDesktopEvent } from "@/desktop/electron/events";
import { PortForwardingController } from "./controller";

const controllers = new WeakMap<DaemonClient, PortForwardingController>();

export function getPortForwarding(client: DaemonClient): PortForwardingController {
  const existing = controllers.get(client);
  if (existing) return existing;
  const controller = new PortForwardingController(client, {
    open: (input) => invokeDesktopCommand("port_forwarding_open", input),
    close: (listenerId) => invokeDesktopCommand("port_forwarding_close", { listenerId }),
    receive: (listenerId, frame) =>
      invokeDesktopCommand("port_forwarding_receive", {
        listenerId,
        frame: encodeTunnelFrame(frame),
      }),
    listen: (handler) =>
      listenToDesktopEvent<{ listenerId: string; frame: Uint8Array }>(
        "port-forwarding",
        (event) => {
          const frame = decodeTunnelFrame(event.frame);
          if (frame) handler(event.listenerId, frame);
        },
      ),
  });
  controllers.set(client, controller);
  return controller;
}
