import { createHash, randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { afterEach, expect, test, vi } from "vitest";
import { buildRelayWebSocketUrl } from "@getpaseo/protocol/daemon-endpoints";
import { ConnectionOfferV2Schema } from "@getpaseo/protocol/connection-offer";
import { getOrCreateServerId } from "../server-id.js";
import { generateLocalPairingOffer } from "../pairing-offer.js";
import { DaemonClient } from "../test-utils/daemon-client.js";
import { createTestPaseoDaemon, type TestPaseoDaemon } from "../test-utils/paseo-daemon.js";
import { createGatewayTestProxy, createGatewayTestRelay } from "../test-utils/relay-gateway.js";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

async function createPeer() {
  const root = await mkdtemp(path.join(os.tmpdir(), "paseo-gateway-peer-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const home = path.join(root, ".paseo");
  await mkdir(home);
  const serverId = getOrCreateServerId(home);
  const token = randomBytes(32).toString("base64url");
  return { root, serverId, token, tokenSha256: createHash("sha256").update(token).digest("hex") };
}

async function connectPublicClient(daemon: TestPaseoDaemon, publicEndpoint: string) {
  const pairing = await generateLocalPairingOffer({
    paseoHome: daemon.paseoHome,
    relayEnabled: true,
    relayEndpoint: daemon.config.relayEndpoint,
    relayPublicEndpoint: daemon.config.relayPublicEndpoint,
    relayUseTls: false,
    relayPublicUseTls: false,
    includeQr: false,
  });
  const encoded = pairing.url!.split("#offer=")[1];
  const offer = ConnectionOfferV2Schema.parse(
    JSON.parse(Buffer.from(encoded, "base64url").toString()),
  );
  expect(offer.relay.endpoint).toBe(publicEndpoint);
  expect(offer.serverId).toBe(daemon.daemon.getServerId());
  expect(JSON.stringify(offer)).not.toContain("gatewayToken");
  if (daemon.config.relayGatewayToken) {
    expect(JSON.stringify(offer)).not.toContain(daemon.config.relayGatewayToken);
  }
  const client = new DaemonClient({
    url: buildRelayWebSocketUrl({
      endpoint: publicEndpoint,
      useTls: false,
      serverId: offer.serverId,
      role: "client",
    }),
    e2ee: { enabled: true, daemonPublicKeyB64: offer.daemonPublicKeyB64 },
    reconnect: { baseDelayMs: 100, maxDelayMs: 100 },
  });
  cleanups.push(async () => {
    await client.close();
  });
  await client.connect();
  return { client, offer };
}

test("three independent daemons share one gateway with real E2EE, isolated agent state and public pairing", async () => {
  const relay = await createGatewayTestRelay();
  cleanups.push(relay.close);
  const proxy = await createGatewayTestProxy();
  cleanups.push(proxy.close);
  const peerA = await createPeer();
  const peerB = await createPeer();
  const windows = await createTestPaseoDaemon({
    relayEnabled: true,
    relayEndpoint: relay.endpoint,
    relayUseTls: false,
    relayProxy: { url: `http://${proxy.endpoint}`, source: "PASEO_RELAY_PROXY" },
    relayGateway: {
      listen: { host: "127.0.0.1", port: 0 },
      peers: [peerA, peerB].map(({ serverId, tokenSha256 }) => ({ serverId, tokenSha256 })),
      maxConnections: 16,
      maxConnectionsPerPeer: 8,
    },
  });
  cleanups.push(windows.close);
  const gateway = windows.daemon.getRelayGatewayStatus()!;
  const children: TestPaseoDaemon[] = [];
  for (const peer of [peerA, peerB]) {
    const daemon = await createTestPaseoDaemon({
      paseoHomeRoot: peer.root,
      relayEnabled: true,
      relayEndpoint: gateway.listen,
      relayUseTls: false,
      relayPublicEndpoint: relay.endpoint,
      relayPublicUseTls: false,
      relayGatewayToken: peer.token,
    });
    cleanups.push(daemon.close);
    children.push(daemon);
  }
  await vi.waitFor(() => expect(relay.controls.size).toBe(3));
  const [windowsClient, clientA, clientB] = await Promise.all(
    [windows, ...children].map((daemon) => connectPublicClient(daemon, relay.endpoint)),
  );
  expect(new Set([windowsClient, clientA, clientB].map(({ offer }) => offer.serverId)).size).toBe(
    3,
  );
  expect(
    new Set([windowsClient, clientA, clientB].map(({ offer }) => offer.daemonPublicKeyB64)).size,
  ).toBe(3);
  const agentA = await clientA.client.createAgent({
    provider: "claude",
    cwd: children[0].staticDir,
  });
  const agentB = await clientB.client.createAgent({
    provider: "claude",
    cwd: children[1].staticDir,
  });
  expect((await clientA.client.fetchAgents()).entries.map((entry) => entry.agent.id)).toEqual([
    agentA.id,
  ]);
  expect((await clientB.client.fetchAgents()).entries.map((entry) => entry.agent.id)).toEqual([
    agentB.id,
  ]);
  expect((await windowsClient.client.fetchAgents()).entries).toEqual([]);
  expect(windows.daemon.getRelayGatewayStatus()).toMatchObject({
    connections: 4,
    pendingConnections: 0,
  });
  expect(proxy.targets.length).toBeGreaterThanOrEqual(6); // control + data for all three daemons
  expect(proxy.targets.every((target) => target === relay.endpoint)).toBe(true);
  expect(relay.requests.every((request) => request.headers.authorization === undefined)).toBe(true);
  relay.disconnect();
  await vi.waitFor(
    async () => {
      expect((await clientA.client.fetchAgents()).entries.map((entry) => entry.agent.id)).toEqual([
        agentA.id,
      ]);
      expect((await clientB.client.fetchAgents()).entries.map((entry) => entry.agent.id)).toEqual([
        agentB.id,
      ]);
    },
    { timeout: 15_000 },
  );
}, 60_000);
