import { createRequire } from "node:module";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { spawn } from "node:child_process";
import { once } from "node:events";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import net from "node:net";
const base = path.dirname(new URL(import.meta.url).pathname);
const repo = path.resolve(process.argv[2]);
const mode = process.argv[3];
assert.ok(["baseline", "fixed"].includes(mode));
const require = createRequire(path.join(base, "source/package.json"));
const { _electron: electron, expect } = require("playwright/test");
const { savePersistedConfig } = await import(require.resolve("@getpaseo/server/configuration"));
const { startDaemonInstance, readDaemonInstance, stopDaemonInstance } = await import(require.resolve("@getpaseo/server/daemon-control"));
const { warmMetro } = await import(path.join(repo, "packages/app/e2e/support/metro-warmup.mjs"));
const root = await mkdtemp(path.join(base, `evidence/latest-${mode}-`));
const pub = path.join(root, "public");
await mkdir(pub);
const home = path.join(root, "external-daemon");
const desktopHome = path.join(root, "desktop-home");
const userData = path.join(root, "user-data");
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("PASEO_") && key !== "ELECTRON_RUN_AS_NODE"));
const listener = net.createServer();
await new Promise(resolve => listener.listen(0, "127.0.0.1", resolve));
const metroPort = listener.address().port;
await new Promise(resolve => listener.close(resolve));
savePersistedConfig(home, {
  daemon: { listen: "127.0.0.1:0", relay: { enabled: false }, cors: { allowedOrigins: [`http://127.0.0.1:${metroPort}`] } },
  features: { dictation: { enabled: false }, voiceMode: { enabled: false } }
});
const redact = (text) => text.replaceAll(os.hostname(), "test-host").replaceAll(base, "<test-checkouts>").replaceAll(os.homedir(), "<user-home>");
let instance, desktop, metro;
try {
  const launch = await startDaemonInstance({ home, command: process.execPath, args: [path.join(repo, "packages/server/dist/scripts/supervisor-entrypoint.js")], env: { ...env, PASEO_HOME: home }, mode: "deployment", timeoutMs: 30000 });
  instance = launch.instance;
  const port = Number(new URL(`http://${instance.listen}`).port);
  assert.ok(port !== 6767 && port !== 6768);
  savePersistedConfig(desktopHome, { daemon: { listen: `127.0.0.1:${port}`, relay: { enabled: false } }, features: { dictation: { enabled: false }, voiceMode: { enabled: false } } });
  const log = createWriteStream(path.join(root, "metro.log"));
  metro = spawn(process.execPath, [path.join(repo, "node_modules/expo/bin/cli"), "start", "--web", "--port", String(metroPort), "--offline"], { cwd: path.join(repo, "packages/app"), detached: true, env: { ...env, EXPO_NO_DOTENV: "1", CI: "1", PASEO_WEB_PLATFORM: "electron" }, stdio: ["ignore", "pipe", "pipe"] });
  metro.stdout.pipe(log, { end: false }); metro.stderr.pipe(log, { end: false });
  await expect.poll(async () => { try { return await (await fetch(`http://127.0.0.1:${metroPort}/status`)).text(); } catch { return ""; } }, { timeout: 60000 }).toBe("packager-status:running");
  await warmMetro(metroPort);
  desktop = await electron.launch({ args: [path.join(repo, "packages/desktop/dist/main.js"), "--no-sandbox"], env: { ...env, PASEO_HOME: desktopHome, PASEO_ELECTRON_USER_DATA_DIR: userData, EXPO_DEV_URL: `http://127.0.0.1:${metroPort}`, PASEO_DISABLE_SINGLE_INSTANCE_LOCK: "1", PASEO_TEST_APP_NAME: "Paseo Reuse QA" } });
  const page = await desktop.firstWindow();
  if (mode === "baseline") {
    await expect(page.getByText("Something went wrong", { exact: true })).toBeVisible({ timeout: 60000 });
    await expect(page.getByText(/EADDRINUSE/).first()).toBeVisible();
    await expect(page.getByTestId("sidebar-settings")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Continue without local server", exact: true })).toHaveCount(0);
    const daemonLog = await readFile(path.join(desktopHome, "daemon.log"), "utf8");
    assert.match(daemonLog, /EADDRINUSE/);
    await writeFile(path.join(pub, "daemon-startup.log"), redact(daemonLog));
    await writeFile(path.join(pub, "visible-error.txt"), redact(await page.locator("body").innerText()));
    // Redact only private machine/path text before capturing the live renderer.
    // This changes no app state, controls, error codes or test assertions.
    await page.evaluate(({ substitutions }) => {
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      let node;
      while ((node = walker.nextNode())) {
        let value = node.nodeValue;
        for (const [from, to] of substitutions) value = value.split(from).join(to);
        node.nodeValue = value;
      }
    }, { substitutions: [[os.hostname(), "test-host"], [base, "<test-checkouts>"], [os.homedir(), "<user-home>"]] });
    await page.screenshot({ path: path.join(pub, "before-error.png") });
    await page.getByRole("button", { name: "Retry", exact: true }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(pub, "before-actions.png") });
  } else {
    await expect(page.getByTestId("sidebar-settings")).toBeVisible({ timeout: 60000 });
    await expect(page.getByText("Something went wrong", { exact: true })).toHaveCount(0);
    assert.equal(await readDaemonInstance(desktopHome), null);
    await assert.rejects(readFile(path.join(desktopHome, "daemon.log")), { code: "ENOENT" });
    await page.screenshot({ path: path.join(pub, "after-auto-connected.png") });
  }
  assert.equal((await readDaemonInstance(home)).pid, instance.pid);
  await desktop.close(); desktop = null;
  assert.equal((await readDaemonInstance(home)).pid, instance.pid);
  assert.equal((await fetch(`http://127.0.0.1:${port}/api/health`)).status, 200);
  const result = { mode, repo: path.basename(repo), version: JSON.parse(await readFile(path.join(repo, "package.json"))).version, listen: instance.listen, externalPidBeforeLaunch: instance.pid, externalPidAfterQuit: (await readDaemonInstance(home)).pid, healthAfterQuit: 200, outcome: mode === "baseline" ? "EADDRINUSE error blocks Settings and Direct connection" : "Automatically connected; no Desktop daemon launched" };
  await writeFile(path.join(pub, "result.json"), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
} finally {
  if (desktop) await desktop.close();
  if (metro && metro.exitCode === null) { const exited = once(metro, "exit"); process.kill(-metro.pid, "SIGTERM"); await exited; }
  if (instance) await stopDaemonInstance(home, { instance, force: true, timeoutMs: 5000 });
  console.log(`Evidence: ${root}`);
}
