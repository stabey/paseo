import { readFile } from "node:fs/promises";
import path from "node:path";

// The daemon runs as plain Node (ELECTRON_RUN_AS_NODE), so it cannot evaluate the
// system proxy configuration (PAC, WPAD, Windows/macOS proxy settings). The
// desktop main process resolves the relay URL through Chromium and hands the
// result to the daemon as PASEO_RELAY_PROXY. The daemon reads that variable in
// packages/server/src/server/relay-proxy.ts.

const DEFAULT_RELAY_ENDPOINT = "relay.paseo.sh:443";
const RESOLVE_TIMEOUT_MS = 3_000;

export interface ResolveDesktopRelayProxyEnvInput {
  home: string;
  env: NodeJS.ProcessEnv;
  resolveProxy: (url: string) => Promise<string>;
  timeoutMs?: number;
}

export interface DesktopRelayProxyResolution {
  env: Record<string, string>;
  relayUrl: string | null;
  proxyList: string | null;
  error: string | null;
}

export async function resolveDesktopRelayProxyEnv(
  input: ResolveDesktopRelayProxyEnvInput,
): Promise<DesktopRelayProxyResolution> {
  if (input.env.PASEO_RELAY_PROXY !== undefined) {
    return { env: {}, relayUrl: null, proxyList: null, error: null };
  }
  const relayUrl = await readRelayUrl(input.home);
  try {
    const proxyList = await withTimeout(
      input.resolveProxy(relayUrl),
      input.timeoutMs ?? RESOLVE_TIMEOUT_MS,
    );
    const proxy = parseChromiumProxyList(proxyList);
    return { env: proxy ? { PASEO_RELAY_PROXY: proxy } : {}, relayUrl, proxyList, error: null };
  } catch (error) {
    return {
      env: {},
      relayUrl,
      proxyList: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Converts a Chromium proxy list ("PROXY a:1; HTTPS b:2; DIRECT") into the first
 * proxy the daemon can use. DIRECT, SOCKS, and QUIC entries yield no proxy.
 */
export function parseChromiumProxyList(proxyList: string): string | null {
  const first = proxyList.split(";")[0]?.trim() ?? "";
  const match = first.match(/^(PROXY|HTTPS)\s+(\S+)$/i);
  if (!match) return null;
  const scheme = match[1].toUpperCase() === "HTTPS" ? "https" : "http";
  return `${scheme}://${match[2]}`;
}

async function readRelayUrl(home: string): Promise<string> {
  const relay = await readPersistedRelay(home);
  const endpoint =
    typeof relay.endpoint === "string" && relay.endpoint ? relay.endpoint : DEFAULT_RELAY_ENDPOINT;
  const useTls =
    typeof relay.useTls === "boolean" ? relay.useTls : endpoint === DEFAULT_RELAY_ENDPOINT;
  return `${useTls ? "https" : "http"}://${endpoint}/`;
}

async function readPersistedRelay(home: string): Promise<Record<string, unknown>> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path.join(home, "config.json"), "utf8"));
    const daemon = isRecord(parsed) ? parsed.daemon : undefined;
    const relay = isRecord(daemon) ? daemon.relay : undefined;
    return isRecord(relay) ? relay : {};
  } catch {
    return {};
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`System proxy resolution timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}
