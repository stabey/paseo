import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseChromiumProxyList, resolveDesktopRelayProxyEnv } from "./relay-proxy-env";

const homes: string[] = [];

async function createHome(config?: unknown): Promise<string> {
  const home = await mkdtemp(path.join(os.tmpdir(), "paseo-relay-proxy-env-"));
  homes.push(home);
  if (config !== undefined) {
    await writeFile(path.join(home, "config.json"), JSON.stringify(config));
  }
  return home;
}

afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

describe("parseChromiumProxyList", () => {
  it.each([
    ["PROXY 10.30.6.50:8080", "http://10.30.6.50:8080"],
    ["PROXY proxy.corp:80; DIRECT", "http://proxy.corp:80"],
    ["HTTPS secure.corp:443", "https://secure.corp:443"],
    ["DIRECT", null],
    ["SOCKS5 socks.corp:1080", null],
    ["", null],
  ])("%s -> %s", (input, expected) => {
    expect(parseChromiumProxyList(input)).toBe(expected);
  });
});

describe("resolveDesktopRelayProxyEnv", () => {
  it("resolves the configured relay URL and passes the proxy to the daemon", async () => {
    const home = await createHome({
      daemon: { relay: { endpoint: "relay.corp.test:443", useTls: true } },
    });
    const requested: string[] = [];
    const result = await resolveDesktopRelayProxyEnv({
      home,
      env: {},
      resolveProxy: async (url) => {
        requested.push(url);
        return "PROXY 10.30.6.50:8080; DIRECT";
      },
    });
    expect(requested).toEqual(["https://relay.corp.test:443/"]);
    expect(result.env).toEqual({ PASEO_RELAY_PROXY: "http://10.30.6.50:8080" });
  });

  it("uses the hosted relay when the config has no endpoint", async () => {
    const home = await createHome();
    const requested: string[] = [];
    const result = await resolveDesktopRelayProxyEnv({
      home,
      env: {},
      resolveProxy: async (url) => {
        requested.push(url);
        return "DIRECT";
      },
    });
    expect(requested).toEqual(["https://relay.paseo.sh:443/"]);
    expect(result.env).toEqual({});
  });

  it("keeps an explicit PASEO_RELAY_PROXY", async () => {
    const home = await createHome();
    const result = await resolveDesktopRelayProxyEnv({
      home,
      env: { PASEO_RELAY_PROXY: "direct" },
      resolveProxy: async () => {
        throw new Error("must not resolve");
      },
    });
    expect(result.env).toEqual({});
    expect(result.error).toBeNull();
  });

  it("starts without a proxy when resolution stalls", async () => {
    const home = await createHome();
    const result = await resolveDesktopRelayProxyEnv({
      home,
      env: {},
      resolveProxy: () => new Promise(() => {}),
      timeoutMs: 10,
    });
    expect(result.env).toEqual({});
    expect(result.error).toMatch(/timed out/);
  });
});
