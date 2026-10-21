#!/usr/bin/env node
import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const bundle = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(join(bundle, "install/package.json"));
const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    tls: { type: "boolean", default: false },
    "public-relay": { type: "string", default: "papaseo.yeexing.online:443" },
  },
});
if (positionals.length !== 1) {
  throw new Error(
    "Usage: configure-relay-gateway.mjs WINDOWS_IP:6769 [--tls] [--public-relay HOST:443]",
  );
}
const endpoint = positionals[0];
const { parseHostPort } = await import(
  pathToFileURL(require.resolve("@getpaseo/protocol/daemon-endpoints"))
);
const gateway = parseHostPort(endpoint);
parseHostPort(values["public-relay"]);
if (endpoint === values["public-relay"])
  throw new Error("Gateway and public relay endpoints must differ");
const home = resolve(process.env.PASEO_HOME || join(homedir(), ".paseo"));
const { readDaemonInstance } = await import(
  pathToFileURL(require.resolve("@getpaseo/server/daemon-control"))
);
if (await readDaemonInstance(home)) throw new Error("Stop this home first: paseo daemon stop");
const { readPersistedConfig, editPersistedConfig } = await import(
  pathToFileURL(require.resolve("@getpaseo/server/configuration"))
);
const { getOrCreateServerId } = await import(
  pathToFileURL(join(dirname(require.resolve("@getpaseo/server")), "server-id.js"))
);
mkdirSync(home, { recursive: true, mode: 0o700 });
const configPath = join(home, "config.json");
const old = readPersistedConfig(home, { defaultsIfMissing: true });
if (old.daemon?.relayGateway?.enabled)
  throw new Error("This home already acts as a gateway; chaining is unsupported");
if (existsSync(configPath)) {
  const backup = join(home, `config.before-relay-gateway-${Date.now()}.json`);
  copyFileSync(configPath, backup);
  chmodSync(backup, 0o600);
}
const previous = old.daemon?.relay?.gatewayToken;
const token =
  previous && /^[A-Za-z0-9_-]{43,128}$/.test(previous)
    ? previous
    : randomBytes(32).toString("base64url");
editPersistedConfig(home, "daemon.relay", {
  value: {
    enabled: true,
    endpoint,
    useTls: values.tls,
    publicEndpoint: values["public-relay"],
    publicUseTls: true,
    gatewayToken: token,
  },
});
if (!old.daemon?.listen) editPersistedConfig(home, "daemon.listen", { value: "127.0.0.1:6767" });
chmodSync(configPath, 0o600);
const serverId = getOrCreateServerId(home, { env: {} });
if (readFileSync(join(home, "server-id"), "utf8").trim() !== serverId)
  throw new Error("Server identity was not persisted");
const snippet = {
  daemon: {
    relayGateway: {
      enabled: true,
      listen: `0.0.0.0:${gateway.port}`,
      peers: [{ serverId, tokenSha256: createHash("sha256").update(token).digest("hex") }],
    },
  },
};
const outputPath = join(home, "windows-relay-gateway.json");
writeFileSync(outputPath, `${JSON.stringify(snippet, null, 2)}\n`, { mode: 0o600 });
chmodSync(outputPath, 0o600);
console.log(
  JSON.stringify(
    { home, serverId, windowsConfigFragment: outputPath, transportTls: values.tls },
    null,
    2,
  ),
);
console.log(
  "Merge daemon.relayGateway from that file into the Windows daemon config; preserve its existing relay/PAC settings.",
);
