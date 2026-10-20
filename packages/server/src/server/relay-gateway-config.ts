import path from "node:path";
import { z } from "zod";
import { parseHostPort } from "@getpaseo/protocol/daemon-endpoints";

export const RelayGatewayTokenSchema = z.string().regex(/^[A-Za-z0-9_-]{43,128}$/, {
  message: "Use a random gateway token with at least 32 bytes encoded as base64url",
});

export const RelayGatewayConfigSchema = z
  .object({
    enabled: z.boolean().optional(),
    listen: z.string().min(1).optional(),
    peers: z
      .array(
        z
          .object({
            serverId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
            tokenSha256: z.string().regex(/^[a-f0-9]{64}$/),
          })
          .strict(),
      )
      .max(128)
      .optional(),
    maxConnections: z.number().int().min(1).max(256).optional(),
    maxConnectionsPerPeer: z.number().int().min(1).max(64).optional(),
    tls: z
      .object({
        certFile: z.string().min(1),
        keyFile: z.string().min(1),
      })
      .strict()
      .optional(),
  })
  .strict();

export interface RelayGatewayConfig {
  listen: { host: string; port: number };
  peers: Array<{ serverId: string; tokenSha256: string }>;
  maxConnections: number;
  maxConnectionsPerPeer: number;
  tls?: { certFile: string; keyFile: string };
}

export function resolveRelayGatewayConfig(
  value: z.infer<typeof RelayGatewayConfigSchema> | undefined,
  paseoHome: string,
): RelayGatewayConfig | null {
  if (!value?.enabled) return null;
  const { host, port } = parseHostPort(value.listen ?? "127.0.0.1:6769");
  const peers = value.peers ?? [];
  if (peers.length === 0) {
    throw new Error("daemon.relayGateway requires at least one authorized peer");
  }
  if (new Set(peers.map((peer) => peer.serverId)).size !== peers.length) {
    throw new Error("daemon.relayGateway.peers contains duplicate server IDs");
  }
  if (new Set(peers.map((peer) => peer.tokenSha256)).size !== peers.length) {
    throw new Error("Each relay gateway peer must have its own token");
  }
  return {
    listen: { host, port },
    peers,
    maxConnections: value.maxConnections ?? 32,
    maxConnectionsPerPeer: value.maxConnectionsPerPeer ?? 16,
    ...(value.tls
      ? {
          tls: {
            certFile: path.resolve(paseoHome, value.tls.certFile),
            keyFile: path.resolve(paseoHome, value.tls.keyFile),
          },
        }
      : {}),
  };
}
