import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import net from "node:net";

const bundle = dirname(fileURLToPath(import.meta.url));
const require = createRequire(join(bundle, "install/package.json"));
const version = "0.12.0-stabey.22";
assert.equal(process.platform, "linux");
assert.equal(process.arch, "x64");
assert.equal(process.version, "v22.20.0");
assert.match(readFileSync("/etc/os-release", "utf8"), /VERSION_ID="22.03"/);
for (const name of ["cli", "client", "highlight", "plugin", "protocol", "relay", "server"]) {
  assert.equal(
    JSON.parse(readFileSync(join(bundle, `install/node_modules/@getpaseo/${name}/package.json`)))
      .version,
    version,
  );
}
assert.ok(
  statSync(
    join(bundle, "install/node_modules/@getpaseo/server/dist/server/web-ui/index.html"),
  ).isFile(),
);
assert.match(
  execFileSync(join(bundle, "bin/paseo"), ["--version"], { encoding: "utf8" }),
  /0\.12\.0-stabey\.22/,
);
const esbuild = require("esbuild");
assert.match(esbuild.transformSync("const value: number = 22", { loader: "ts" }).code, /22/);
const { pack, unpack } = require("msgpackr");
assert.deepEqual(unpack(pack({ native: 22 })), { native: 22 });
const pty = require("node-pty");
await new Promise((resolve, reject) => {
  let output = "";
  const terminal = pty.spawn("/bin/sh", ["-c", "printf paseo-offline-native-ok"], {
    cwd: tmpdir(),
    env: { PATH: "/usr/bin:/bin" },
  });
  terminal.onData((data) => {
    output += data;
  });
  const timeout = setTimeout(() => {
    terminal.kill();
    reject(new Error("PTY timeout"));
  }, 5000);
  terminal.onExit(({ exitCode }) => {
    clearTimeout(timeout);
    if (exitCode === 0 && output.includes("paseo-offline-native-ok")) resolve();
    else reject(new Error(`PTY failed: ${exitCode}`));
  });
});
const gatewayHome = mkdtempSync(join(tmpdir(), "paseo-gateway-config-"));
const helper = join(bundle, "bin/configure-relay-gateway.mjs");
const helperEnv = { ...process.env, PASEO_HOME: gatewayHome };
execFileSync(process.execPath, [helper, "192.0.2.10:6769"], { env: helperEnv, stdio: "pipe" });
const configured = JSON.parse(readFileSync(join(gatewayHome, "config.json")));
const snippet = JSON.parse(readFileSync(join(gatewayHome, "windows-relay-gateway.json")));
assert.equal(configured.daemon.relay.endpoint, "192.0.2.10:6769");
assert.equal(configured.daemon.relay.publicEndpoint, "papaseo.yeexing.online:443");
assert.equal(configured.daemon.relay.useTls, false);
assert.equal(
  snippet.daemon.relayGateway.peers[0].tokenSha256,
  createHash("sha256").update(configured.daemon.relay.gatewayToken).digest("hex"),
);
execFileSync(process.execPath, [helper, "192.0.2.10:6769"], { env: helperEnv, stdio: "pipe" });
assert.equal(
  JSON.parse(readFileSync(join(gatewayHome, "config.json"))).daemon.relay.gatewayToken,
  configured.daemon.relay.gatewayToken,
);
assert.equal(statSync(join(gatewayHome, "config.json")).mode & 0o777, 0o600);
const home = mkdtempSync(join(tmpdir(), "paseo-offline-smoke-"));
const listener = net.createServer();
listener.listen(0, "127.0.0.1");
await once(listener, "listening");
const port = listener.address().port;
await new Promise((resolve) => listener.close(resolve));
writeFileSync(
  join(home, "config.json"),
  JSON.stringify({ daemon: { listen: `127.0.0.1:${port}`, relay: { enabled: false } } }),
);
const env = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => !key.startsWith("PASEO_")),
);
env.PASEO_HOME = home;
env.PASEO_RELAY_ENABLED = "0";
const daemon = spawn(join(bundle, "bin/paseo"), ["daemon", "run"], {
  env,
  detached: true,
  stdio: ["ignore", "pipe", "pipe"],
});
let logs = "";
daemon.stdout.on("data", (data) => {
  logs = (logs + data).slice(-20000);
});
daemon.stderr.on("data", (data) => {
  logs = (logs + data).slice(-20000);
});
const { DaemonClient } = await import(
  pathToFileURL(require.resolve("@getpaseo/client/internal/daemon-client"))
);
const WebSocket = require("ws");
let client;
try {
  const deadline = Date.now() + 60000;
  while (true) {
    assert.equal(daemon.exitCode, null, logs);
    client = new DaemonClient({
      url: `ws://127.0.0.1:${port}/ws`,
      clientId: "offline-package-smoke",
      clientType: "cli",
      appVersion: version,
      localCredential: () => readFileSync(join(home, "local-credential"), "utf8").trim(),
      connectTimeoutMs: 2500,
      webSocketFactory: (url, opts) =>
        new WebSocket(url, opts?.protocols, { headers: opts?.headers }),
      reconnect: { enabled: false },
    });
    try {
      await client.connect();
      break;
    } catch (error) {
      await client.close();
      if (Date.now() >= deadline) throw new Error(`${String(error)}\n${logs}`, { cause: error });
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  const info = client.getLastServerInfoMessage();
  assert.equal(info.version, version);
  assert.ok(info.features.workspacePortForwarding && info.features.projectSearchRoots);
  assert.equal((await client.fetchAgents()).entries.length, 0);
  assert.equal((await client.scheduleList()).error, null);
  const status = await client.getDaemonStatus({ timeout: 25000 });
  assert.equal(status.version, version);
  console.log(
    JSON.stringify({
      version,
      platform: process.platform,
      arch: process.arch,
      node: process.version,
      nodeAbi: process.versions.modules,
      os: "openEuler 22.03 LTS",
      network: "none (docker --network none)",
      native: { pty: true, esbuild: true, msgpackr: true },
      daemonStartup: true,
      directSdk: true,
      schedules: true,
      gatewayConfigurationHelper: true,
      verifiedAt: new Date().toISOString(),
    }),
  );
} finally {
  await client?.close();
  if (daemon.exitCode === null) {
    const stopped = once(daemon, "exit");
    process.kill(-daemon.pid, "SIGTERM");
    const timeout = setTimeout(() => {
      try {
        process.kill(-daemon.pid, "SIGKILL");
      } catch {}
    }, 15000);
    await stopped;
    clearTimeout(timeout);
  }
}
