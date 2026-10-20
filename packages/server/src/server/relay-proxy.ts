import * as tls from "node:tls";

// Node 22.15+/23.10+. Older @types/node in this repo predate it.
type CertificateStore = "default" | "system" | "bundled" | "extra";
interface TlsWithCertificateStores {
  getCACertificates?: (store?: CertificateStore) => string[];
}

/**
 * Proxy selection for the daemon's outbound relay WebSockets.
 *
 * `PASEO_RELAY_PROXY` wins when present: the desktop app sets it from the
 * system proxy resolution (PAC/WPAD), and `direct` or an empty value forces a
 * direct connection. Otherwise the conventional `HTTPS_PROXY`/`HTTP_PROXY`/
 * `ALL_PROXY` variables apply, honoring `NO_PROXY`.
 *
 * Only HTTP(S) CONNECT proxies are supported; SOCKS values are ignored.
 */
export type RelayProxySource = "PASEO_RELAY_PROXY" | "environment";

export interface RelayProxySelection {
  url: string;
  source: RelayProxySource;
}

export interface ResolveRelayProxyInput {
  env: NodeJS.ProcessEnv;
  endpoint: string;
  useTls: boolean;
}

const DIRECT_VALUES = new Set(["", "direct", "none", "off"]);

export function resolveRelayProxy(input: ResolveRelayProxyInput): RelayProxySelection | null {
  const explicit = input.env.PASEO_RELAY_PROXY;
  if (explicit !== undefined) {
    const value = explicit.trim();
    if (DIRECT_VALUES.has(value.toLowerCase())) return null;
    const url = normalizeProxyUrl(value);
    return url ? { url, source: "PASEO_RELAY_PROXY" } : null;
  }

  const { host, port } = splitEndpoint(input.endpoint, input.useTls ? 443 : 80);
  if (isNoProxyMatch(readEnv(input.env, "NO_PROXY"), host, port)) return null;

  const candidate = input.useTls
    ? (readEnv(input.env, "HTTPS_PROXY") ?? readEnv(input.env, "ALL_PROXY"))
    : (readEnv(input.env, "HTTP_PROXY") ?? readEnv(input.env, "ALL_PROXY"));
  if (!candidate) return null;
  const url = normalizeProxyUrl(candidate);
  return url ? { url, source: "environment" } : null;
}

/** Proxy URL safe for logs and diagnostics: credentials removed. */
export function redactProxyUrl(proxyUrl: string): string {
  try {
    const url = new URL(proxyUrl);
    url.username = "";
    url.password = "";
    return url.origin;
  } catch {
    return "[invalid proxy url]";
  }
}

/**
 * Trust anchors for relay TLS: Node's bundled roots plus the operating system
 * store. Corporate gateways that re-sign HTTPS traffic install their root in the
 * system store, which Node does not consult by default. Returns undefined when
 * the system store adds nothing, so the default TLS behavior is unchanged.
 */
export function resolveRelayCertificateAuthorities(): string[] | undefined {
  const getCACertificates = (tls as TlsWithCertificateStores).getCACertificates;
  if (!getCACertificates) return undefined;
  try {
    const system = getCACertificates("system");
    if (system.length === 0) return undefined;
    return [...new Set([...getCACertificates("default"), ...system])];
  } catch {
    return undefined;
  }
}

function readEnv(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = env[name] ?? env[name.toLowerCase()];
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function normalizeProxyUrl(value: string): string | null {
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `http://${value}`;
  try {
    const url = new URL(withScheme);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (!url.hostname) return null;
    return url.toString();
  } catch {
    return null;
  }
}

function splitEndpoint(endpoint: string, defaultPort: number): { host: string; port: number } {
  try {
    const url = new URL(`http://${endpoint}`);
    return {
      host: url.hostname.replace(/^\[|\]$/g, "").toLowerCase(),
      port: url.port ? Number(url.port) : defaultPort,
    };
  } catch {
    return { host: endpoint.toLowerCase(), port: defaultPort };
  }
}

function isNoProxyMatch(noProxy: string | undefined, host: string, port: number): boolean {
  if (!noProxy) return false;
  for (const raw of noProxy.split(/[\s,]+/)) {
    const entry = raw.trim().toLowerCase();
    if (!entry) continue;
    if (entry === "*") return true;
    const { host: entryHost, port: entryPort } = splitNoProxyEntry(entry);
    if (entryPort !== null && entryPort !== port) continue;
    const suffix = entryHost.replace(/^\*?\./, "");
    if (!suffix) continue;
    if (host === suffix || host.endsWith(`.${suffix}`)) return true;
  }
  return false;
}

function splitNoProxyEntry(entry: string): { host: string; port: number | null } {
  const bracketed = entry.match(/^\[([^\]]+)\](?::(\d+))?$/);
  if (bracketed) {
    return { host: bracketed[1], port: bracketed[2] ? Number(bracketed[2]) : null };
  }
  const parts = entry.split(":");
  if (parts.length === 2 && /^\d+$/.test(parts[1])) {
    return { host: parts[0], port: Number(parts[1]) };
  }
  return { host: entry, port: null };
}
