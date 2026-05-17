# @swarmai/device-agent

> SwarmAI Remote Device Agent — a daemon that opens an outbound WebSocket
> to a SwarmAI gateway and registers the device's local tools (clipboard,
> screenshot, CLI wrappers) for remote dispatch by the main agent.
>
> Solves the NAT-traversal problem that the inbound-listening
> `apps/node-worker` doesn't: a phone in Termux, a laptop on hotel WiFi,
> or a home desktop behind a consumer router can all dial OUT to the
> gateway and become first-class tool providers.
>
> Wire-protocol spec: `docs/37-remote-device-agent.md` in the SwarmAI
> monorepo.

## Install

```bash
npm install -g @swarmai/device-agent
```

That puts `swarmai-device-agent` on your PATH and pulls in
`@swarmai/desktop` + `@swarmai/cli-tools` transitively, so the daemon
has tools to expose out of the box.

## Quick start

On the **gateway** (operator side):

```bash
swarmai device pair --name "my-phone" --platform android
# → Pair code: ABC123 (valid 5 min)
```

On the **device** (the phone / laptop / server you're enrolling):

```bash
swarmai-device-agent pair --server https://my.gateway.example.com --pair-code ABC123
swarmai-device-agent run
```

The first command exchanges the short-lived pair code for a long-lived
device token and writes it to `~/.swarmai/device-agent.yaml` (chmod
0600 on POSIX). The second opens the WebSocket and stays connected.

## CLI reference

```
swarmai-device-agent pair --server <URL> --pair-code <CODE>
                          [--name <NAME>] [--platform auto|darwin|linux|win32|android|wsl]
swarmai-device-agent run  [--server <URL>] [--config <path>]
swarmai-device-agent status
swarmai-device-agent rotate
swarmai-device-agent forget
```

| Command  | What it does                                                                                |
| -------- | ------------------------------------------------------------------------------------------- |
| `pair`   | Exchange a one-time code for a device token. Persists to the config.                        |
| `run`    | Open the WS, announce local tools, process invocations. Auto-reconnects on disconnect.      |
| `status` | Print current config (token redacted) and tool catalog size. Reports "not paired" cleanly.  |
| `rotate` | Rotate the device token without re-pairing. Requires an active pair.                        |
| `forget` | Delete the local config. Server-side record is NOT revoked — use `swarmai device kick`.     |

`--platform auto` (default) detects via `process.platform`, with a
Termux-on-Android override: if `$PREFIX === /data/data/com.termux/files/usr`
the daemon reports `android`. WSL is detected via `$WSL_DISTRO_NAME`.

## Config file

Default path: `~/.swarmai/device-agent.yaml` (or
`%USERPROFILE%\.swarmai\device-agent.yaml` on Windows).

Override with `$SWARMAI_DEVICE_AGENT_CONFIG` or `--config <path>`.

```yaml
serverUrl: 'https://my-gateway.example.com'
deviceId: 'dev_abc12345'
displayName: 'phone (Samsung Galaxy S23)'
token: 'urlsafe-base64-32-bytes'   # NEVER COMMIT THIS FILE
gatewayName: 'main-prod'
platform: 'android'
firstConnectedAt: '2026-05-17T10:00:00Z'
```

## Wire protocol

JSON-RPC 2.0 over WebSocket. The bearer token rides in the
`Sec-WebSocket-Protocol` header (never a query param). See
`docs/37-remote-device-agent.md` §2 for the full spec.

| Direction | Verbs                                                                          |
| --------- | ------------------------------------------------------------------------------ |
| Server →  | `welcome`, `tool/invoke`, `device/disconnect`, `device/ping`                   |
| Device →  | `device/announce`, `tool/result`, `device/heartbeat`, `device/tools-changed`   |

## Security

- Token is chmod 0600 (POSIX) and lives under the user profile (Windows
  ACL default). v0.2 adds Keychain / Credential Manager integration.
- Pair code is masked as `***` in any error output.
- Device tools are gated by the pair-time `acceptedToolPolicies` set by
  the gateway operator — `master`-policy tools can be refused entirely.
- TLS is the operator's responsibility — front the gateway with Caddy /
  nginx / Cloudflare Tunnel before exposing over the internet.

## License

PolyForm Noncommercial 1.0.0. See `LICENSE`.
