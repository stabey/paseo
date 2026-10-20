---
title: Configuration
description: Configure managed instances and foreground deployments.
nav: Configuration
order: 40
category: Configuration
---

# Configuration

Managed instances load their configuration from the home’s `config.json` and defaults. Foreground deployments can override that file with environment variables.

## Where config lives

By default, Paseo uses `~/.paseo` as its home directory. The configuration file is:

```bash
~/.paseo/config.json
```

You can change the home directory by setting `PASEO_HOME` or selecting `--home` on a CLI command.

## Precedence

Managed `start` and Desktop use defaults, then `config.json`. Inherited daemon-setting environment variables are removed from their launches.

Foreground `paseo daemon run`, Docker, and direct supervisor launches apply environment variables after the file. Existing legacy supervisor flags retain their precedence across worker restart. Changing deployment overrides requires stopping and relaunching that deployment. Lists append across sources, including hostnames and CORS origins.

## Example

Minimal example that configures listening address, hostnames, and MCP:

```json
{
  "$schema": "https://paseo.sh/schemas/paseo.config.v1.json",
  "version": 1,
  "daemon": {
    "listen": "127.0.0.1:6767",
    "hostnames": ["localhost", ".localhost"],
    "mcp": { "enabled": true }
  }
}
```

`daemon.hostnames` is the primary field. The old `daemon.allowedHosts` name still works as a deprecated alias for backward compatibility.

## Apply changes

Edit the selected file through the CLI:

```bash
paseo daemon config get daemon.listen --home ~/paseo-test
paseo daemon config set daemon.listen 127.0.0.1:6800 --home ~/paseo-test
paseo daemon config unset features.webUi.enabled --home ~/paseo-test
```

`get [path]` reports configured values and labels missing fields unset. It does not create a home. `set` parses JSON, otherwise treats the input as a string; `--string` forces a literal string. `--json` selects output format. Use whole-object JSON for dynamic keys containing dots. Unknown paths, invalid values, and invalid existing files are rejected without writing. Passwords use `set-password`.

A successful edit saves the validated file, then reloads once if the instance is reachable. Output distinguishes applied changes, restart requirements, and deployment overrides. A stopped/unbound/unreachable instance reports **saved; not applied**. A failed reload reports **saved; reload failed** with a nonzero exit; the file remains saved. Edits never implicitly restart.

After editing `config.json` directly, reload it:

```bash
paseo reload
```

The daemon validates the complete file before applying anything. It applies runtime-safe changes and lists any settings that still need a restart. If it reports restart-required paths, run:

```bash
paseo daemon restart
```

Runtime-safe settings include project search roots, relay enablement, MCP settings, browser tools, hostnames, CORS origins, trusted proxies, Git process limits, agent and terminal profiles, provider definitions, metadata generation, the app base URL, provider catalog timeout, and the global plugin switch. Removing one of these settings applies its omitted-field behavior; removing a provider removes it from future launches.

New homes keep relay disabled when you remove `daemon.relay.enabled`. A daemon whose config already omitted this field when it started keeps the legacy relay-enabled behavior for compatibility. Set `daemon.relay.enabled` explicitly when editing an older config.

Listen addresses, authentication, relay endpoints and TLS, worktree allocation, service-proxy addresses, the bundled web UI, logging, speech, voice, credentials, and local model settings require a restart. Reload applies other valid edits in the same file before reporting those paths.

Deployment environment variables and legacy supervisor flags remain authoritative. Reload reports a changed file setting under `overrideControlledPaths` when a launch override prevents it from taking effect. This includes startup settings such as listen addresses, passwords, relay endpoints and TLS, service-proxy and web UI settings, logging, speech, and voice configuration. List settings such as hostnames and CORS origins still append across sources, so values from `config.json` continue to apply. Stop and relaunch the deployment without the override to make the file value authoritative.

## Agent providers

Agent providers, both the first-class ones Paseo ships with and custom entries you add under `agents.providers`, are documented on their own page.

See [Providers](/docs/providers) for the mental model and [Supported providers](/docs/supported-providers) for the full list of agents Paseo can launch. For pointing Claude at Anthropic-compatible endpoints (Z.AI, Alibaba/Qwen), multiple profiles, custom binaries, ACP agents, and the `additionalModels` merge behavior, see [Custom providers](/docs/custom-providers). The full field reference lives on GitHub at [docs/custom-providers.md](https://github.com/getpaseo/paseo/blob/main/docs/custom-providers.md).

## Project directory search

Project keyword search defaults to the daemon user's home directory. In **Settings → Host →
Projects → Project search directories**, select your host, add or remove directories, and select
**Save**. Changes apply immediately. **Reset to home** restores the home-only list when saved.
This editor requires a host that supports project search directories.

You can also include an external disk or another checkout location in `projects.searchRoots`:

```json
{
  "projects": {
    "searchRoots": ["~", "/Volumes/macport"]
  }
}
```

The list replaces the default roots, so include `~` to keep searching home. Supply 1–16 absolute
paths or paths beginning with `~/`; paths belong to the daemon host, not the phone or browser.
Results from overlapping roots are deduplicated and ranked together. Search shares a bounded
scan budget across roots and skips missing or unreadable directories, including unmounted disks.
Remove `projects.searchRoots` to restore the home-only default.

Run `paseo reload` after editing the file. Subsequent searches in existing clients use the new
roots without restarting agents. For example, `bridge` can find `/Volumes/macport/bridge` with
the configuration above. `~/...` and `./...` still refer to home; explicitly entered absolute
paths browse that location even when it is outside the configured search roots. Empty queries
do not scan the roots.

These settings control project discovery, not file access permissions. They do not change
workspace/composer search scope or which directories the daemon user can open.

## Worktrees

New worktrees are created under `$PASEO_HOME/worktrees` by default. To place new worktrees somewhere else, set `worktrees.root`:

```json
{
  "worktrees": {
    "root": "/mnt/fast/paseo-worktrees"
  }
}
```

Relative paths are resolved against `PASEO_HOME`. Existing worktrees remain where they are; changing this setting only changes where Paseo creates and discovers Paseo-managed worktrees going forward.

## Voice

Voice is configured through `features.dictation` and `features.voiceMode`, with provider credentials under `providers`.

For voice philosophy, architecture, and complete local/OpenAI setup examples, see [Voice docs](/docs/voice).

## Bundled web UI

The daemon can serve the browser web client from the same HTTP server. This is enabled in the official Docker image and disabled by default for normal CLI and desktop-managed daemons.

Enable it from the CLI:

```bash
paseo daemon config set features.webUi.enabled true
paseo daemon start
```

Or set the environment variable:

```bash
PASEO_WEB_UI_ENABLED=true paseo daemon run
```

Or persist it in `config.json`:

```json
{
  "features": {
    "webUi": {
      "enabled": true
    }
  }
}
```

When enabled, open the daemon HTTP origin, for example `http://localhost:6767/`, to load the web app. Static UI files load without daemon auth; API and WebSocket requests still require the configured password.

## Logging

Daemon logging uses separate console and file sinks by default:

- Console: `info` and above
- File (`$PASEO_HOME/daemon.log`): `trace` and above
- File rotation: `10m` max file size, `3` rotated files kept alongside the active file

```json
{
  "log": {
    "console": {
      "level": "info",
      "format": "pretty"
    },
    "file": {
      "level": "trace",
      "path": "daemon.log",
      "rotate": {
        "maxSize": "10m",
        "maxFiles": 3
      }
    }
  }
}
```

Legacy fields `log.level` and `log.format` are still supported and map to the new destination settings.

## Password authentication

You can require a password to connect to the daemon. When set, all HTTP and WebSocket clients must authenticate. Only the `/api/health` liveness endpoint is exempt, so that process supervisors and load balancers can probe without credentials.

The easiest way to set a password is with the CLI:

```bash
paseo daemon set-password
```

This prompts for a password, writes the bcrypt hash to `config.json`, and tells you to restart the daemon. Authentication is a startup setting, so `paseo reload` will also report it as restart-required.

Alternatively, set the `PASEO_PASSWORD` environment variable (plaintext, hashed automatically at startup):

```bash
PASEO_PASSWORD=my-secret paseo daemon start
```

Or write the hash directly in `config.json`:

```json
{
  "daemon": {
    "auth": {
      "password": "$2b$12$..."
    }
  }
}
```

After setting a password, restart the daemon for the change to take effect.

### Connecting with a password

The CLI picks up a password from, in order:

1. The `password` query parameter on a `tcp://` host URI:

   ```bash
   paseo --host "tcp://192.168.1.10:6767?password=my-secret" ls
   ```

2. The `PASEO_PASSWORD` environment variable, used as a fallback when the host carries no embedded password (works for `localhost:6767`, bare `host:port`, or `tcp://` hosts without a `password=` query):

   ```bash
   PASEO_PASSWORD=my-secret paseo ls
   PASEO_PASSWORD=my-secret paseo --host 192.168.1.10:6767 ls
   ```

A `password=` in the URI always wins over the env var, so you can keep `PASEO_PASSWORD` set globally and still target a different daemon by spelling its password into the URI.

In the mobile app, enter the password in the direct connection setup screen.

## Relay

New homes write `daemon.relay.enabled: false`. Paseo asks before enabling relay when you pair a device; existing homes keep their saved value. See [Connectivity](/docs/connectivity) to choose and configure a connection method, and [Security](/docs/security) for the relay encryption model.

Set the persisted value in `config.json`:

```json
{
  "daemon": {
    "relay": {
      "enabled": true
    }
  }
}
```

`PASEO_RELAY_ENABLED=true|false` overrides the file for a foreground deployment. Managed `start` uses the file. End and relaunch a deployment to remove its override before changing relay from the app or `paseo daemon pair --relay`.

### Relay through a proxy

The daemon connects to the relay through an HTTP CONNECT proxy when one is configured. Paseo Desktop resolves the system proxy settings, including PAC and WPAD, for the relay URL each time it starts its daemon. Other daemons read `HTTPS_PROXY` (`HTTP_PROXY` for a relay without TLS) or `ALL_PROXY`, and skip the proxy when `NO_PROXY` matches the relay host. `PASEO_RELAY_PROXY` overrides both; set it to `direct` to connect without a proxy. SOCKS proxies are not supported.

Relay TLS also trusts certificates in the operating system store, so a gateway that re-signs HTTPS with a corporate root works once that root is installed on the machine. The active proxy appears under **Relay proxy** in the host's full status.

### Relay through another daemon

A daemon can optionally provide a **relay gateway** for other daemons that can reach
it but cannot reach the public relay. For example, a build container can connect
to a Windows workstation, which opens the upstream relay connections using its
existing PAC-selected HTTP proxy and system certificate store.

Each daemon keeps its own server ID, keypair, pairing link, agents, and workspaces.
Clients still connect to the public relay. The gateway forwards relay protocol
messages and encrypted payloads without decrypting the downstream daemon's
client sessions. It opens separate control and data sockets for each downstream;
it does not multiplex them into its own daemon session.

The gateway is disabled by default and uses a separate listener. Its peer
credentials grant only relay forwarding, not access to the gateway host's agents.
It accepts daemon-side relay v2 connections to the host's configured
`daemon.relay.endpoint`; callers cannot choose arbitrary destinations.
One gateway can serve multiple peers. Chaining gateways is not supported.

#### Authorize a downstream daemon

Initialize the downstream daemon with its own home and read its `serverId` with
`paseo daemon status --json`. Do not copy the gateway host's home or keypair.
Generate a different token for each downstream (Node is available with the CLI):

```sh
node -e "const c=require('node:crypto');const token=c.randomBytes(32).toString('base64url');console.log(JSON.stringify({token,tokenSha256:c.createHash('sha256').update(token).digest('hex')},null,2))"
```

Store the `token` only on the downstream. Put the `tokenSha256` and that
downstream's server ID in the gateway host's config. Replace the example
addresses and capitalized placeholders below and merge these fields with the
existing config:

```json
{
  "daemon": {
    "relay": {
      "endpoint": "relay.example.com:443",
      "useTls": true
    },
    "relayGateway": {
      "enabled": true,
      "listen": "10.20.0.10:17890",
      "peers": [
        {
          "serverId": "DOWNSTREAM_SERVER_ID",
          "tokenSha256": "TOKEN_SHA256"
        }
      ]
    }
  }
```

Use the existing public relay endpoint on the gateway host. Its own
`daemon.relay.enabled` controls only its own relay registration; the gateway is
enabled independently. PAC resolution still happens in Desktop when it launches
the daemon, exactly as for the host's own relay connections.

For an internal network you trust, the downstream can use the following config:

```json
{
  "daemon": {
    "relay": {
      "enabled": true,
      "endpoint": "10.20.0.10:17890",
      "useTls": false,
      "publicEndpoint": "relay.example.com:443",
      "publicUseTls": true,
      "gatewayToken": "TOKEN"
    }
  }
}
```

`endpoint` is the reachable gateway listener. `publicEndpoint` is where external
clients meet this downstream daemon; it must be different from `endpoint`.
`gatewayToken` authenticates both control and data connections and is never
included in pairing links. A downstream using a gateway connects directly to
that gateway, ignoring internet proxy environment variables for this route.
After restarting the selected daemons, pair clients using the **downstream's**
`paseo daemon pair` link.

The access token travels in the WebSocket upgrade's Authorization header.
For a network you do not trust, configure TLS on the gateway and use
`daemon.relay.useTls: true` on the downstream:

```json
{
  "daemon": {
    "relayGateway": {
      "tls": {
        "certFile": "gateway.crt",
        "keyFile": "gateway.key"
      }
    }
  }
}
```

Merge `tls` into the enabled gateway configuration above. Paths are relative to
that daemon's home; absolute paths also work. The downstream must trust the
certificate issuer, and the certificate must match the hostname or IP in
`endpoint`. Bind the gateway to the intended LAN interface and allow only the
build server's source address through the workstation firewall.

#### Lifecycle and diagnostics

Gateway configuration, peer authorization, certificates, and downstream
`gatewayToken` are startup settings. `paseo reload` reports that a restart is
needed. Removing a peer and restarting the gateway revokes its access and closes
existing forwarding connections.

**Full status** reports the gateway listener, authorized peer count, open and
pending connection counts, and peer IDs. Default limits are 32 connections total
and 16 per peer, including pending upstream handshakes. Configure
`daemon.relayGateway.maxConnections` (1–256) and `maxConnectionsPerPeer` (1–64)
when needed. Each peer consumes one control connection plus one data connection
per connected client.

Upstream loss closes the corresponding downstream connections so the existing
daemon relay reconnect logic can recover. Gateway shutdown closes all forwarded
connections. The downstream daemon and its agents continue to run when its
gateway is unavailable.

The gateway reuses the same upstream WebSocket factory and PAC-selected proxy as
the host daemon. PAC chooses a proxy; it does **not** implement NTLM, Kerberos,
or interactive proxy login. A `relay_gateway_upstream_rejected` log with status
407 requires resolving authentication on the gateway host. Relay forwarding
does not proxy agent model requests.

## Common env vars

- `PASEO_HOME`, set Paseo home directory
- `PASEO_HOST`, set the daemon target for CLI commands
- `PASEO_PASSWORD`, on the daemon, the password to require (plaintext, hashed at startup); on the CLI, the password used to connect when the host URI doesn't include one
- `PASEO_LISTEN`, override `daemon.listen`
- `PASEO_RELAY_ENABLED`, enable or disable the outbound relay for this daemon launch
- `PASEO_RELAY_PROXY`, HTTP proxy for relay connections, or `direct`; see [Relay through a proxy](#relay-through-a-proxy)
- `PASEO_HOSTNAMES`, override/extend `daemon.hostnames`
- `PASEO_ALLOWED_HOSTS`, deprecated alias for `PASEO_HOSTNAMES`
- `PASEO_WEB_UI_ENABLED`, enable or disable the daemon-served web UI
- `PASEO_WEB_UI_DIST_DIR`, override the daemon web UI build directory
- `PASEO_TRUSTED_PROXIES`, configure trusted reverse proxy ranges for `X-Forwarded-*` headers
- `PASEO_LOG_CONSOLE_LEVEL`, override `log.console.level`
- `PASEO_LOG_FILE_LEVEL`, override `log.file.level`
- `PASEO_LOG_FILE_PATH`, override `log.file.path`
- `PASEO_LOG_FILE_ROTATE_SIZE`, override `log.file.rotate.maxSize`
- `PASEO_LOG_FILE_ROTATE_COUNT`, override `log.file.rotate.maxFiles`
- `PASEO_LOG`, `PASEO_LOG_FORMAT`, legacy log overrides (still supported)
- `OPENAI_API_KEY`, override OpenAI provider key
- `OPENAI_STT_API_KEY`, `OPENAI_STT_BASE_URL`, OpenAI speech-to-text endpoint (dictation + voice mode STT)
- `OPENAI_TTS_API_KEY`, `OPENAI_TTS_BASE_URL`, OpenAI text-to-speech endpoint (voice mode TTS)
- `PASEO_VOICE_LLM_PROVIDER`, override voice LLM provider (`claude`, `codex`, `opencode`)
- `PASEO_DICTATION_STT_PROVIDER`, `PASEO_VOICE_STT_PROVIDER`, `PASEO_VOICE_TTS_PROVIDER`, override voice provider selection (`local` or `openai`)
- `PASEO_LOCAL_MODELS_DIR`, control local model directory
- `PASEO_DICTATION_LOCAL_STT_MODEL`, override local dictation STT model
- `PASEO_VOICE_LOCAL_STT_MODEL`, `PASEO_VOICE_LOCAL_TTS_MODEL`, override local voice STT/TTS models
- `PASEO_DICTATION_LANGUAGE`, `PASEO_VOICE_LANGUAGE`, override dictation and voice STT language
- `PASEO_VOICE_LOCAL_TTS_SPEAKER_ID`, `PASEO_VOICE_LOCAL_TTS_SPEED`, optional local voice TTS tuning

## Schema

For editor autocomplete/validation, set `$schema` to:

```
https://paseo.sh/schemas/paseo.config.v1.json
```
