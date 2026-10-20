import { HttpsProxyAgent } from "https-proxy-agent";
import { WebSocket, type ClientOptions } from "ws";
import { resolveRelayCertificateAuthorities, type RelayProxySelection } from "./relay-proxy.js";
import { MAX_PHYSICAL_SOCKET_BUFFERED_BYTES } from "./websocket/physical-socket.js";

/** Shared by this daemon's relay transport and its optional downstream gateway. */
export function createRelayWebSocketFactory(
  proxy: RelayProxySelection | null,
  gatewayToken?: string,
): (url: string) => WebSocket {
  const options: ClientOptions = {
    handshakeTimeout: 10_000,
    perMessageDeflate: false,
    followRedirects: false,
    maxPayload: MAX_PHYSICAL_SOCKET_BUFFERED_BYTES,
  };
  const ca = resolveRelayCertificateAuthorities();
  if (ca) options.ca = ca;
  if (proxy) options.agent = new HttpsProxyAgent(proxy.url, ca ? { ca } : {});
  // Never put gateway credentials in URLs, pairing offers, or relay protocol frames.
  if (gatewayToken) options.headers = { Authorization: `Bearer ${gatewayToken}` };
  return (url) => new WebSocket(url, options);
}
