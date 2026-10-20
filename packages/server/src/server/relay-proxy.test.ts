import { describe, expect, test } from "vitest";
import { redactProxyUrl, resolveRelayProxy } from "./relay-proxy";

const endpoint = "relay.example.com:443";

describe("resolveRelayProxy", () => {
  test("uses no proxy when nothing is configured", () => {
    expect(resolveRelayProxy({ env: {}, endpoint, useTls: true })).toBeNull();
  });

  test("prefers PASEO_RELAY_PROXY over standard variables and NO_PROXY", () => {
    expect(
      resolveRelayProxy({
        env: {
          PASEO_RELAY_PROXY: "10.30.6.50:8080",
          HTTPS_PROXY: "http://other:3128",
          NO_PROXY: "example.com",
        },
        endpoint,
        useTls: true,
      }),
    ).toEqual({ url: "http://10.30.6.50:8080/", source: "PASEO_RELAY_PROXY" });
  });

  test("PASEO_RELAY_PROXY=direct disables standard proxy variables", () => {
    expect(
      resolveRelayProxy({
        env: { PASEO_RELAY_PROXY: "DIRECT", HTTPS_PROXY: "http://proxy:3128" },
        endpoint,
        useTls: true,
      }),
    ).toBeNull();
  });

  test("uses HTTPS_PROXY for TLS relays and HTTP_PROXY for plain relays", () => {
    const env = { https_proxy: "http://secure:3128", HTTP_PROXY: "http://plain:3128" };
    expect(resolveRelayProxy({ env, endpoint, useTls: true })).toEqual({
      url: "http://secure:3128/",
      source: "environment",
    });
    expect(resolveRelayProxy({ env, endpoint: "relay.example.com:80", useTls: false })).toEqual({
      url: "http://plain:3128/",
      source: "environment",
    });
  });

  test("falls back to ALL_PROXY", () => {
    expect(
      resolveRelayProxy({ env: { ALL_PROXY: "http://all:3128" }, endpoint, useTls: true }),
    ).toEqual({ url: "http://all:3128/", source: "environment" });
  });

  test.each([
    ["*"],
    ["example.com"],
    [".example.com"],
    ["*.example.com"],
    ["localhost, relay.example.com:443"],
  ])("NO_PROXY=%s bypasses the proxy", (noProxy) => {
    expect(
      resolveRelayProxy({
        env: { HTTPS_PROXY: "http://proxy:3128", NO_PROXY: noProxy },
        endpoint,
        useTls: true,
      }),
    ).toBeNull();
  });

  test.each([["ample.com"], ["relay.example.com:8443"], ["other.com"]])(
    "NO_PROXY=%s does not match the relay",
    (noProxy) => {
      expect(
        resolveRelayProxy({
          env: { HTTPS_PROXY: "http://proxy:3128", NO_PROXY: noProxy },
          endpoint,
          useTls: true,
        }),
      ).not.toBeNull();
    },
  );

  test("ignores SOCKS and malformed proxies", () => {
    expect(
      resolveRelayProxy({ env: { HTTPS_PROXY: "socks5://proxy:1080" }, endpoint, useTls: true }),
    ).toBeNull();
    expect(
      resolveRelayProxy({ env: { PASEO_RELAY_PROXY: "http://" }, endpoint, useTls: true }),
    ).toBeNull();
  });
});

describe("redactProxyUrl", () => {
  test("removes credentials", () => {
    expect(redactProxyUrl("http://user:secret@proxy.corp:8080/")).toBe("http://proxy.corp:8080");
  });
});
