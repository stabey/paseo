Paseo 0.12.0-stabey.22 — openEuler 22.03 / Linux x86_64 / Node 22 offline package

This directory includes all production npm dependencies and the bundled web UI.
It reuses the Node v22.20.0 already installed in your container. Do not run npm
install on the offline machine. No AI agent CLI or model weights are included.

1. Extract the archive into a persistent directory, then enter that directory.
   export PATH="$PWD/bin:$PATH"
   export PASEO_HOME="$HOME/.paseo"
   paseo --version

   Ensure PASEO_HOME survives container recreation. Use the same Linux user and
   PATH that you normally use to run your AI agent and compile your project.

2. Configure the container (replace WINDOWS_IP with its reachable LAN address):
   node bin/configure-relay-gateway.mjs WINDOWS_IP:6769
   cat "$PASEO_HOME/windows-relay-gateway.json"

   The helper creates this daemon's own server ID, a random per-daemon token and
   a Windows config fragment. The raw token remains in the container's private
   config.json. Re-running the helper preserves the existing token and identity.
   It backs up existing config and refuses to edit a running daemon home.

3. Upgrade Windows to stabey.22, stop its old daemon, and exit Paseo Desktop.
   Merge daemon.relayGateway from the generated file into the Windows daemon's
   existing config.json. Preserve Windows daemon.relay and its PAC configuration.
   If relayGateway already has peers, append this peer instead of replacing them.
   Start the new Windows Paseo Desktop so it resolves PAC for the daemon.

   relayGateway.listen is 0.0.0.0:6769 by default in the generated fragment.
   You can bind the specific Windows LAN IP instead. Do not use 127.0.0.1 for
   this listener. Windows daemon.listen may remain 127.0.0.1:6767.
   Allow inbound TCP 6769 only from the compile server's source IP in Windows
   Firewall. Container-to-Windows outbound connectivity is sufficient: you do
   not need to publish a Docker port for this relay connection.

4. Start and pair the container daemon:
   paseo daemon start
   paseo daemon status --json
   paseo daemon pair --json

   Paste connectionUri (or the pairing link) into Paseo's Add host flow.
   Pair the container separately from the Windows daemon. Its pairing offer uses
   papaseo.yeexing.online:443 and does not expose the Windows LAN address/token.

   Logs: $PASEO_HOME/daemon.log
   Stop: paseo daemon stop
   Foreground/supervisor mode: paseo daemon run
   Add startup to your existing container entrypoint or supervisor if you need
   automatic startup after container restarts.

The default gateway transport is plain WebSocket for a trusted LAN. The gateway
token is sent without TLS on that LAN segment, while client-to-container content
retains Paseo's end-to-end encryption. For TLS, configure relayGateway.tls.certFile
and keyFile on Windows, run the helper with --tls, and make the container trust
the certificate (e.g. NODE_EXTRA_CA_CERTS pointing to the issuing CA file).

The public relay address can be overridden with --public-relay HOST:443.
Windows must be online, its daemon running and its PAC/proxy working for the
container's relay connection to work. This feature does not proxy model traffic.
