# Service Proxy

Paseo gives workspace services two access paths: desktop port forwarding through your existing daemon connection, and HTTP proxy URLs on the daemon host. Choose desktop forwarding when the daemon is remote and its service ports are unreachable from your device. Generated `.localhost` URLs refer to the machine opening the URL; a relay connection alone does not make those hostnames remote.

## Desktop port forwarding

Open **Scripts → Ports** in a workspace. Running managed services appear automatically. For a service started outside the workspace script runner, enter its host port and choose **Save and forward**. The daemon probes TCP reachability before the desktop opens a local listener. Arbitrary processes started by agents are not discovered in this version.

Use the displayed `127.0.0.1` address on your desktop. An automatic local port prefers the host port and selects a free port if it is occupied. An explicit local port must be available. **Open** uses the selected HTTP or HTTPS scheme; **Copy address** also works for raw TCP services. Running script links offer **Forward to this device**.

Port definitions are saved with the daemon workspace. Local listeners belong to the desktop window and connection: stop forwarding, reload or close the window, or disconnect the host to release them. Reconnect and select **Forward** to start again. **Remove** deletes a manual definition; **Stop forwarding** keeps it. A service must listen on IPv4 loopback or all IPv4 interfaces on the daemon host.

The tunnel carries TCP bytes, including WebSocket upgrades, through the authenticated connection. Relay connections retain the existing end-to-end encryption, and the relay needs no new routes or deployment. TLS, HTTP headers, redirects, cookies, and development-server host checks are unchanged; configure the service for the displayed local origin when needed. This path does not provide a public URL or a browser/mobile HTTPS gateway.

The daemon requires `tunnel.manage` and only connects to loopback ports registered in that workspace or assigned to its running managed services. This permission allows adding a manual target, so it grants access to daemon-host loopback services; workspace association is not OS process isolation. Desktop listeners bind to loopback too. Each physical connection owns its streams, including when two connections share a client ID. Removing an allowed target or revoking the permission closes affected streams.

Both client and daemon need the forwarding feature. Older daemons keep their existing service links; the Ports sheet asks you to update the host.

## HTTP proxy on the daemon host

When a `paseo.json` script of `"type": "service"` starts, Paseo assigns it a local port and registers a route in the service proxy. Incoming requests whose `Host` header matches the script's generated hostname are forwarded to that port.

The generated hostname is built from the script name, branch, and project:

```
<script>--<branch>--<project>.localhost
```

If the branch is `main` or `master`, the branch segment is omitted:

```
<script>--<project>.localhost
```

**Example:** a script named `dev` in the `miniweb` project on branch `feature/auth` would be reachable at:

```
dev--feature-auth--miniweb.localhost
```

Local and public routes use one combined leftmost label (`script--branch--project`). This keeps the hostname compatible with normal single-level wildcard DNS and TLS. If the combined label would exceed DNS's 63-character label limit, Paseo truncates it with a deterministic hash suffix to avoid collisions.

## Managing workspace scripts

Configured `paseo.json` scripts can be managed without addressing their backing terminal directly:

```bash
paseo script ls [--cwd <path> | --workspace <workspace-id>]
paseo script start <name> [--cwd <path> | --workspace <workspace-id>]
paseo script stop <name> [--cwd <path> | --workspace <workspace-id>]
```

The commands return the same script metadata shown by the workspace: lifecycle, service port, proxy URLs, health, exit code, and supervised terminal ID. `stop` terminates the managed terminal rather than only removing the proxy route, so normal script lifecycle cleanup remains authoritative. MCP exposes matching `list_workspace_scripts`, `start_workspace_script`, and `stop_workspace_script` tools; those require an explicit workspace ID.

## Configuration

Add a `serviceProxy` block under `daemon` in `~/.paseo/config.json`:

```json
{
  "version": 1,
  "daemon": {
    "serviceProxy": {
      "listen": "0.0.0.0:8080",
      "publicBaseUrl": "https://paseoapps.my.domain.com"
    }
  }
}
```

| Field           | Required | Description                                                                                                                                   |
| --------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `listen`        | No       | Starts a separate service-only listener at this address. If omitted, services are still reachable on the daemon listener via localhost hosts. |
| `publicBaseUrl` | No       | Adds public service host aliases and public service links. If omitted, links use localhost addresses only.                                    |

`enabled` is accepted for old configs but no longer enables a mode. `enabled: false` suppresses optional `listen`/`publicBaseUrl` layers only; localhost service proxying remains always enabled.

## DNS and reverse proxy setup

For generated URLs to be reachable, you need wildcard DNS pointing to the machine running the Paseo daemon.

**Example:** to expose services at `https://dev--miniweb.paseoapps.my.domain.com` where the daemon host is `10.1.1.1`:

1. Configure a wildcard DNS record:

   ```
   *.paseoapps.my.domain.com  →  10.1.1.1
   ```

2. Set `publicBaseUrl` to `https://paseoapps.my.domain.com` in your config.

3. If you put a reverse proxy (nginx, Caddy, Traefik, etc.) in front of Paseo, point it at either the daemon listener or the optional service-only listener and ensure it forwards the `Host` header unchanged. The proxy uses the `Host` header to route requests to the correct service — rewriting it will break routing.

Public service URLs expose the workspace service itself. Daemon password authentication protects daemon APIs; it does not protect proxied dev services.

If the same reverse proxy serves the daemon web UI over HTTPS, it must also set `X-Forwarded-Proto` so the web UI can auto-connect with `wss://`. The daemon trusts forwarded headers from loopback proxies by default. If your proxy reaches the daemon from another address, configure the proxy ranges explicitly:

```json
{
  "version": 1,
  "daemon": {
    "trustedProxies": ["loopback", "172.16.0.0/12"]
  }
}
```

`PASEO_TRUSTED_PROXIES` accepts the same comma-separated values, for example `loopback,172.16.0.0/12`. Use `true` only when the final trusted proxy overwrites client-supplied `X-Forwarded-*` headers.

Nginx example:

```nginx
server {
    listen 443 ssl;
    server_name *.paseoapps.my.domain.com;

    location / {
        proxy_pass http://10.1.1.1:8080;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

Nginx's `$host` drops the port. If you terminate on a non-default port, use `$http_host` instead so the port survives — that is what "forwards the `Host` header unchanged" means here.

## Forwarded headers

Paseo sets these when it forwards a request to a workspace service:

| Header              | Value                                                                                                                                   |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `X-Forwarded-Host`  | The `Host` header verbatim, including the port when the client used one                                                                 |
| `X-Forwarded-Proto` | The request scheme (`http` on the WebSocket upgrade path)                                                                               |
| `X-Forwarded-For`   | The immediate peer address. Replaces any existing chain, so behind your own reverse proxy this is the proxy's address, not the client's |
| `X-Forwarded-Port`  | The port from the `Host` header when it has one, otherwise whatever your proxy already set                                              |

`X-Forwarded-Port` follows the same trust rule as `X-Forwarded-Host`: the authority Paseo observed wins. When the `Host` header carries a port, that port is reported and replaces any inbound `X-Forwarded-Port`, so a client cannot forge one. When `Host` carries no port there is nothing to observe, so a value your reverse proxy set survives untouched — that is the case where nginx's `$host` drops the port and `X-Forwarded-Port` is the only source. Paseo never derives the port from the scheme. Any other `X-Forwarded-*` header your proxy sends is passed through untouched.

Services that build absolute URLs should prefer `Host` or `X-Forwarded-Host`.

### The forwarded authority is not authenticated

Route lookup normalizes the port away before matching a service hostname, so a client can address the daemon with any port in `Host` and still reach the service. That port is what lands in `X-Forwarded-Host` and `X-Forwarded-Port`. Paseo also does not check whether an inbound `X-Forwarded-Port` came from a proxy in `trustedProxies` — when `Host` carries no port, a client-supplied value is passed through.

Treat the forwarded authority as client-influenced input. A service that builds password reset links, absolute redirects, or cached URLs from it should pin its own public origin in configuration rather than deriving one from request headers. This is not specific to `X-Forwarded-Port`: the `Host` header has always carried a client-chosen port.

## Environment variables

The listen address and public base URL can also be set via environment variables, which take precedence over `config.json`:

| Variable                              | Description                                                               |
| ------------------------------------- | ------------------------------------------------------------------------- |
| `PASEO_SERVICE_PROXY_ENABLED`         | Compatibility shim; `false` suppresses optional public/listen layers only |
| `PASEO_SERVICE_PROXY_LISTEN`          | Starts the optional service-only listener, e.g. `0.0.0.0:8080`            |
| `PASEO_SERVICE_PROXY_PUBLIC_BASE_URL` | Adds public service aliases and links                                     |
