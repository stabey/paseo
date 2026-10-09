import http from "node:http";
import net from "node:net";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { createDaemonTestContext } from "../test-utils/daemon-test-context.js";
import { DaemonClient } from "../test-utils/daemon-client.js";
import { PortForwarding } from "../../../../desktop/src/daemon/port-forwarding.js";
import {
  TunnelOpcode,
  TunnelCloseReason,
  type TunnelFrame,
} from "@getpaseo/protocol/binary-frames/index";

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).toReversed()) await fn();
});

test("persists workspace ports, forwards HTTP over the real daemon connection, and revokes removed targets", async () => {
  const ctx = await createDaemonTestContext();
  cleanup.push(ctx.cleanup);
  const cwd = await mkdtemp(path.join(tmpdir(), "paseo-ports-"));
  cleanup.push(() => rm(cwd, { recursive: true, force: true }));
  const opened = await ctx.client.openProject(cwd);
  if (!opened.workspace) throw new Error(opened.error ?? "No workspace returned");
  const workspaceId = opened.workspace.id;
  const service = http.createServer((_req, res) => res.end("through the daemon"));
  cleanup.push(() => {
    service.closeAllConnections();
    service.close();
  });
  service.listen(0, "127.0.0.1");
  await once(service, "listening");
  const address = service.address();
  if (!address || typeof address === "string") throw new Error("No service address");
  const port = address.port;
  expect(ctx.client.getLastServerInfoMessage()?.features?.workspacePortForwarding).toBe(true);
  await expect(ctx.client.probeWorkspacePort({ workspaceId, port })).rejects.toThrow(
    "not registered",
  );
  expect(
    await ctx.client.setWorkspacePort({
      workspaceId,
      port,
      configuration: { label: "Preview", protocol: "http" },
    }),
  ).toEqual([{ port, label: "Preview", protocol: "http" }]);
  const saved = await readFile(
    path.join(ctx.daemon.paseoHome, "projects", "workspaces.json"),
    "utf8",
  );
  expect(JSON.parse(saved)).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        workspaceId,
        portForwards: [{ port, label: "Preview", protocol: "http" }],
      }),
    ]),
  );
  await ctx.client.probeWorkspacePort({ workspaceId, port });
  const desktop = new PortForwarding(async (_id, frame) => ctx.client.sendTunnelFrame(frame));
  cleanup.push(() => desktop.dispose());
  const unsubscribe = ctx.client.onTunnelFrame((frame) => desktop.receive("test", frame));
  cleanup.push(unsubscribe);
  const local = await desktop.open({ listenerId: "test", workspaceId, port, localPort: 0 });
  const response = await fetch(`http://127.0.0.1:${local.localPort}/`, {
    headers: { Connection: "close" },
  });
  expect(await response.text()).toBe("through the daemon");
  await ctx.client.setWorkspacePort({ workspaceId, port, configuration: null });
  await expect(ctx.client.probeWorkspacePort({ workspaceId, port })).rejects.toThrow(
    "not registered",
  );
}, 30_000);

test("isolates simultaneous sockets sharing a client ID and closes only the detached source", async () => {
  const ctx = await createDaemonTestContext();
  cleanup.push(ctx.cleanup);
  const cwd = await mkdtemp(path.join(tmpdir(), "paseo-port-sources-"));
  cleanup.push(() => rm(cwd, { recursive: true, force: true }));
  const opened = await ctx.client.openProject(cwd);
  if (!opened.workspace) throw new Error(opened.error ?? "No workspace returned");
  const sockets = new Set<net.Socket>();
  const service = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("data", (data) => socket.write(data));
  });
  cleanup.push(() => {
    for (const socket of sockets) socket.destroy();
    service.close();
  });
  service.listen(0, "127.0.0.1");
  await once(service, "listening");
  const address = service.address();
  if (!address || typeof address === "string") throw new Error("No service address");
  const port = address.port;
  const workspaceId = opened.workspace.id;
  await ctx.client.setWorkspacePort({
    workspaceId,
    port,
    configuration: { label: "Echo", protocol: "tcp" },
  });
  const clients = [0, 1].map(
    () =>
      new DaemonClient({
        url: `ws://127.0.0.1:${ctx.daemon.port}/ws`,
        clientId: "shared-tunnel-client",
      }),
  );
  const received: TunnelFrame[][] = [[], []];
  for (const [index, client] of clients.entries()) {
    cleanup.push(() => client.close());
    await client.connect();
    client.onTunnelFrame((frame) => received[index].push(frame));
    client.sendTunnelFrame({ opcode: TunnelOpcode.Open, streamId: "same-id", workspaceId, port });
    await expect
      .poll(() => received[index])
      .toContainEqual({ opcode: TunnelOpcode.Opened, streamId: "same-id" });
  }
  clients[0].sendTunnelFrame({
    opcode: TunnelOpcode.Data,
    streamId: "same-id",
    payload: new TextEncoder().encode("private"),
  });
  await expect
    .poll(() => received[0].filter((frame) => frame.opcode === TunnelOpcode.Data).length)
    .toBe(1);
  expect(received[1]).toEqual([{ opcode: TunnelOpcode.Opened, streamId: "same-id" }]);
  await clients[0].close();
  await expect.poll(() => sockets.size).toBe(1);
  await ctx.client.setWorkspacePort({ workspaceId, port, configuration: null });
  await expect
    .poll(() => received[1])
    .toContainEqual({
      opcode: TunnelOpcode.Close,
      streamId: "same-id",
      reason: TunnelCloseReason.Forbidden,
    });
  await expect.poll(() => sockets.size).toBe(0);
}, 30_000);

test("discovers a running managed service without manual configuration and rejects it after stop", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "paseo-managed-port-"));
  cleanup.push(() => rm(cwd, { recursive: true, force: true }));
  await writeFile(
    path.join(cwd, "preview.cjs"),
    'require("node:http").createServer((req, res) => res.end("managed")).listen(Number(process.env.PASEO_PORT), "127.0.0.1");',
  );
  await writeFile(
    path.join(cwd, "paseo.json"),
    JSON.stringify({ scripts: { preview: { type: "service", command: "node preview.cjs" } } }),
  );
  const ctx = await createDaemonTestContext();
  cleanup.push(ctx.cleanup);
  const opened = await ctx.client.openProject(cwd);
  if (!opened.workspace) throw new Error(opened.error ?? "No workspace returned");
  const workspaceId = opened.workspace.id;
  expect(opened.workspace.portForwards).toEqual([]);
  expect((await ctx.client.startWorkspaceScript(workspaceId, "preview")).error).toBeNull();
  const script = (await ctx.client.listWorkspaceScripts(workspaceId)).scripts.find(
    (entry) => entry.scriptName === "preview",
  );
  if (!script?.port) throw new Error("Managed service has no assigned port");
  const target = { workspaceId, port: script.port };
  await expect
    .poll(
      async () => {
        try {
          await ctx.client.probeWorkspacePort(target);
          return true;
        } catch {
          return false;
        }
      },
      { timeout: 10_000 },
    )
    .toBe(true);
  expect((await ctx.client.stopWorkspaceScript(workspaceId, "preview")).error).toBeNull();
  await expect(ctx.client.probeWorkspacePort(target)).rejects.toThrow("not registered");
}, 30_000);
