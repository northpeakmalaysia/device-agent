/**
 * Entry point for `swarmai-device-agent` (doc 37 §6).
 *
 * The tool-providing plugins (`@swarmai/desktop`, `@swarmai/cli-tools`)
 * are loaded via `loadToolPlugins()` BEFORE any command runs. Each
 * module calls `register({...})` from `@swarmai/tools` at evaluation
 * time, populating the in-process tool registry. By the time `run`
 * opens the WebSocket and snapshots the catalog, everything that's
 * going to register has registered.
 *
 * The loader is dynamic-import based so a missing peer (e.g. the
 * operator installed `@swarmai/device-agent` standalone without the
 * tool plugins yet) produces a warning at startup rather than a hard
 * crash — the daemon still runs and the catalog is just empty. The
 * gateway will see an empty `device/announce` and the agent can still
 * use the device for `device/ping` liveness even with no tools.
 */
import { hostname, platform as osPlatform } from 'node:os';
import pkg from '../package.json' with { type: 'json' };
const pkgName = pkg.name;
const pkgVersion = pkg.version;
import {
  defaultConfigPath,
  loadConfig,
  deleteConfig,
  configExistsSync,
  type DeviceConfig,
} from './config.js';
import { pairAndPersist, PairError } from './pair.js';
import { createLogger, type LogLevel } from './logger.js';

const PROG = 'swarmai-device-agent';

// ---------------------------------------------------------------------
//  Tool-plugin loader — dynamic, tolerant of missing peers
// ---------------------------------------------------------------------

/** Plugins we side-effect-import to populate the in-process tool registry. */
const TOOL_PLUGIN_PACKAGES = ['@swarmai/desktop', '@swarmai/cli-tools'] as const;

/**
 * Try to import each tool-plugin package. Missing packages emit a
 * warning on stderr but don't abort the daemon — operators may run
 * `swarmai-device-agent` in an enviroment where only a subset of
 * plugins are installed (or none at all, for debug / status / pair).
 */
async function loadToolPlugins(): Promise<{ loaded: string[]; missing: string[] }> {
  const loaded: string[] = [];
  const missing: string[] = [];
  for (const pkgId of TOOL_PLUGIN_PACKAGES) {
    try {
      await import(pkgId);
      loaded.push(pkgId);
    } catch (err) {
      const code = (err as { code?: string } | undefined)?.code;
      if (code === 'ERR_MODULE_NOT_FOUND' || code === 'MODULE_NOT_FOUND') {
        missing.push(pkgId);
      } else {
        // A real load error (syntax error, etc.) — surface it but
        // continue so the daemon's other commands still work.
        process.stderr.write(
          `${PROG}: warning — failed to load tool plugin ${pkgId}: ${
            err instanceof Error ? err.message : err
          }\n`,
        );
        missing.push(pkgId);
      }
    }
  }
  return { loaded, missing };
}

// ---------------------------------------------------------------------
//  Help / version
// ---------------------------------------------------------------------

function printHelp(): void {
  process.stdout.write(
    `${PROG} v${pkgVersion} — SwarmAI Remote Device Agent (doc 37)

Usage:
  ${PROG} pair --server <URL> --pair-code <CODE> [--name <NAME>] [--platform auto|darwin|linux|win32|android|wsl]
  ${PROG} run [--server <URL>] [--config <path>] [--quiet | --verbose]
  ${PROG} status
  ${PROG} rotate
  ${PROG} forget
  ${PROG} --help | -h
  ${PROG} --version

Commands:
  pair       Exchange a one-time pair code for a long-lived device token,
             then persist it to the config file (default: ~/.swarmai/device-agent.yaml).

  run        Open the WebSocket to the configured gateway, announce local
             tools, and process inbound tool/invoke calls. Auto-reconnects
             on disconnect with exponential backoff (1s→60s, jittered).
             Send SIGINT or SIGTERM for graceful shutdown.

  status     Print the current config (token redacted) and tool catalog
             size. Reports "not paired" cleanly when no config exists.

  rotate     Trigger token rotation on the gateway and update the local
             config with the new token. Requires an active pair.

  forget     Delete the local config. The device must re-pair to reconnect.
             Note: this does NOT revoke the token server-side — use
             \`swarmai device kick <id>\` from the gateway for that.

Options:
  --server <URL>       Gateway URL, e.g. http://localhost:7910 or https://my.gateway.com
                       (Only required for \`pair\`; \`run\` reads from the config.)
  --pair-code <CODE>   Short-lived pair code minted by the gateway operator.
  --name <NAME>        Friendly device display name (default: hostname).
  --platform <P>       Reported platform: auto|darwin|linux|win32|android|wsl
                       (default: auto — detects Termux as 'android').
  --config <path>      Override the config file path.
  --quiet              Errors only — suppress state and frame logging.
  --verbose, -v        Verbose: also log heartbeats, reconnect attempts,
                       and raw frame previews (truncated to ~120 chars).

Environment:
  SWARMAI_DEVICE_AGENT_CONFIG   Overrides the default config path.
  NO_COLOR                      Disables ANSI colour in log output.
`,
  );
}

function printVersion(): void {
  void pkgName;
  process.stdout.write(`${pkgVersion}\n`);
}

// ---------------------------------------------------------------------
//  Minimal arg parser — no third-party dep, ~30 LoC
// ---------------------------------------------------------------------

interface ParsedArgs {
  command: string;
  flags: Record<string, string | true>;
}

function parseArgs(argv: string[]): ParsedArgs {
  // argv = process.argv.slice(2)
  if (argv.length === 0) {
    return { command: '', flags: {} };
  }
  // Top-level flag-as-command: `--help`, `-h`, `--version` should be
  // recognised even when no subcommand was given.
  //
  // Note on `-v`: when it appears as the SOLE top-level argument we
  // treat it as the legacy `--version` shortcut (back-compat). When it
  // appears as a flag *after* a subcommand (e.g. `run -v`) the loop
  // below records it as `flags.v = true`, which `cmdRun` maps to
  // verbose logging.
  const startIdx = 1;
  let command: string;
  const first = argv[0]!;
  if (first === '--help' || first === '-h' || first === 'help') {
    command = 'help';
  } else if (first === '--version' || (first === '-v' && argv.length === 1)) {
    command = '--version';
  } else if (first.startsWith('-')) {
    // A bare flag without a subcommand — treat as help-with-error.
    return { command: 'help', flags: { _badInvocation: first } };
  } else {
    command = first;
  }
  const flags: Record<string, string | true> = {};
  for (let i = startIdx; i < argv.length; i++) {
    const tok = argv[i]!;
    if (tok.startsWith('--')) {
      const eqIdx = tok.indexOf('=');
      if (eqIdx >= 0) {
        flags[tok.slice(2, eqIdx)] = tok.slice(eqIdx + 1);
      } else {
        const key = tok.slice(2);
        // Boolean-only flags must NOT consume the next positional —
        // otherwise `run --verbose --server URL` would treat URL as
        // the value of --verbose. Keep the list explicit; everything
        // else falls back to the "consume-next-non-flag" behaviour
        // already in use for `--server VALUE` etc.
        const BOOLEAN_FLAGS = new Set([
          'verbose',
          'quiet',
          'help',
          'version',
        ]);
        const next = argv[i + 1];
        if (
          !BOOLEAN_FLAGS.has(key) &&
          next !== undefined &&
          !next.startsWith('--') &&
          !next.startsWith('-')
        ) {
          flags[key] = next;
          i += 1;
        } else {
          flags[key] = true;
        }
      }
    } else if (tok.startsWith('-')) {
      flags[tok.slice(1)] = true;
    }
    // Positionals beyond the command are currently ignored — no
    // subcommand needs them yet.
  }
  return { command, flags };
}

/**
 * Translate `--quiet` / `--verbose` / `-v` flags into a LogLevel. The
 * two verbosity flags are mutually exclusive — passing both is treated
 * as an operator error (we surface a clear warning + bias toward the
 * safer choice, `verbose`, so debug output isn't silently suppressed).
 */
function resolveLogLevel(flags: Record<string, string | true>): LogLevel {
  const quiet = flags['quiet'] === true;
  const verbose = flags['verbose'] === true || flags['v'] === true;
  if (quiet && verbose) {
    process.stderr.write(
      `${PROG}: --quiet and --verbose are mutually exclusive; using --verbose.\n`,
    );
    return 'verbose';
  }
  if (verbose) return 'verbose';
  if (quiet) return 'quiet';
  return 'normal';
}

// ---------------------------------------------------------------------
//  Platform detection (doc 37 §6.2 — `--platform auto`)
// ---------------------------------------------------------------------

function detectPlatform(): DeviceConfig['platform'] {
  // Termux on Android sets $PREFIX to its own usr root.
  if (process.env.PREFIX === '/data/data/com.termux/files/usr') {
    return 'android';
  }
  // WSL: $WSL_DISTRO_NAME is set inside WSL, $WSL_INTEROP often too.
  if (process.env.WSL_DISTRO_NAME || process.env.WSL_INTEROP) {
    return 'wsl';
  }
  const p = osPlatform();
  if (p === 'darwin' || p === 'linux' || p === 'win32') return p;
  // Fallback for unsupported Node platforms (aix, freebsd, …). The
  // gateway only validates against the 5 known strings; falling back
  // to `linux` is the closest practical match and won't break the
  // pair-redeem POST.
  return 'linux';
}

function normalisePlatform(
  value: string | true | undefined,
): DeviceConfig['platform'] {
  if (value === undefined || value === true || value === 'auto') {
    return detectPlatform();
  }
  const allowed: DeviceConfig['platform'][] = [
    'darwin',
    'linux',
    'win32',
    'android',
    'wsl',
  ];
  if (allowed.includes(value as DeviceConfig['platform'])) {
    return value as DeviceConfig['platform'];
  }
  throw new Error(
    `--platform must be one of: auto, ${allowed.join(', ')} (got: ${value})`,
  );
}

// ---------------------------------------------------------------------
//  Subcommands
// ---------------------------------------------------------------------

async function cmdPair(flags: Record<string, string | true>): Promise<number> {
  const level = resolveLogLevel(flags);
  const logger = createLogger(level);

  const server = strFlag(flags, 'server');
  const pairCode = strFlag(flags, 'pair-code');
  const name = strFlag(flags, 'name', false) ?? defaultDisplayName();
  const platformVal = normalisePlatform(flags['platform']);
  const configPath =
    strFlag(flags, 'config', false) ?? defaultConfigPath();

  if (!server) {
    process.stderr.write(`${PROG}: --server <URL> is required\n`);
    return 2;
  }
  if (!pairCode) {
    process.stderr.write(`${PROG}: --pair-code <CODE> is required\n`);
    return 2;
  }

  try {
    const result = await pairAndPersist(
      {
        serverUrl: server,
        pairCode,
        deviceName: name,
        platform: platformVal,
        agentVersion: pkgVersion,
        logger,
      },
      configPath,
    );
    process.stdout.write(
      `Paired successfully.\n` +
        `  device id:   ${result.deviceId}\n` +
        `  display:     ${result.displayName}\n` +
        `  gateway:     ${result.gatewayName}\n` +
        `  server:      ${result.serverUrl}\n` +
        `  config:      ${configPath}\n` +
        `  token:       (written to config; never echoed)\n\n` +
        `Next: run \`${PROG} run\` to bring the agent online.\n`,
    );
    return 0;
  } catch (err) {
    if (err instanceof PairError) {
      process.stderr.write(`${PROG}: pair failed (${err.code}): ${err.message}\n`);
      return err.code === 'network' ? 3 : 4;
    }
    process.stderr.write(
      `${PROG}: pair failed: ${err instanceof Error ? err.message : err}\n`,
    );
    return 1;
  }
}

async function cmdRun(flags: Record<string, string | true>): Promise<number> {
  const level = resolveLogLevel(flags);
  const logger = createLogger(level);

  const configPath = strFlag(flags, 'config', false) ?? defaultConfigPath();
  const cfg = await loadConfig(configPath);
  if (!cfg) {
    // Use logger.error so the "not paired" message lands on stderr with
    // the standard prefix even at default verbosity — operators on a
    // fresh device must always see this.
    logger.error(
      `not paired. Run \`${PROG} pair --server <URL> --pair-code <CODE>\` first. (Looked for config at: ${configPath})`,
    );
    return 5;
  }

  // Optional --server override: useful when a paired device moves to a
  // different gateway URL (e.g. operator switched domains) without
  // wanting to rotate the token. The token still has to be valid on
  // the new gateway — usually paired with a manual config edit.
  const serverOverride = strFlag(flags, 'server', false);
  const effective: DeviceConfig = serverOverride
    ? { ...cfg, serverUrl: serverOverride }
    : cfg;

  // Load tool plugins + dynamic-import the connect/catalog modules.
  // These imports are deferred until `run` so `pair` / `status` /
  // `--help` work in environments where `@swarmai/tools` isn't
  // installed (the daemon ships as a binary; the host that pulls it
  // in is responsible for surfacing the registry).
  const pluginLoad = await loadToolPlugins();
  if (pluginLoad.missing.length > 0) {
    logger.state(
      `tool plugins not found: ${pluginLoad.missing.join(', ')}; running with ${pluginLoad.loaded.length} loaded`,
    );
  }

  let snapshotCatalog: typeof import('./catalog.js').snapshotCatalog;
  let startConnection: typeof import('./connect.js').startConnection;
  try {
    ({ snapshotCatalog } = await import('./catalog.js'));
    ({ startConnection } = await import('./connect.js'));
  } catch (err) {
    logger.error(
      `cannot start — \`@swarmai/tools\` is not installed in this environment. Run inside the bundled distribution at \`F:/Published/SwarmAI/\` (or wherever your operator installed it), or \`npm install -g @swarmai/tools\` once the package is published.`,
      err,
    );
    return 6;
  }

  const catalog = await snapshotCatalog();
  logger.state(
    `starting (device=${effective.deviceId}, platform=${effective.platform}, tools=${catalog.length})`,
  );

  const conn = startConnection({
    config: effective,
    agentVersion: pkgVersion,
    logger,
  });

  // Wire signals for graceful shutdown.
  const shutdown = async (sig: NodeJS.Signals) => {
    logger.state(`received ${sig}, shutting down…`);
    try {
      await conn.close();
    } catch (err) {
      logger.error('shutdown error', err);
    }
  };
  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));

  await conn.done;
  logger.state('exited');
  return 0;
}

async function cmdStatus(): Promise<number> {
  const path = defaultConfigPath();
  if (!configExistsSync(path)) {
    process.stdout.write(
      `${PROG}: not paired.\n  config path: ${path}\n  detected platform: ${detectPlatform()}\n`,
    );
    return 0;
  }
  try {
    const cfg = await loadConfig(path);
    if (!cfg) {
      process.stdout.write(`${PROG}: config at ${path} is empty.\n`);
      return 0;
    }
    // Catalog snapshot is best-effort — if @swarmai/tools isn't
    // installed, report `unknown` rather than failing.
    let toolsLine = '  tools loaded: unknown (@swarmai/tools not installed)\n';
    try {
      await loadToolPlugins();
      const { snapshotCatalog } = await import('./catalog.js');
      const catalog = await snapshotCatalog();
      toolsLine = `  tools loaded: ${catalog.length}\n`;
    } catch {
      /* keep unknown */
    }
    process.stdout.write(
      `${PROG} v${pkgVersion}\n` +
        `  config:       ${path}\n` +
        `  server:       ${cfg.serverUrl}\n` +
        `  device id:    ${cfg.deviceId}\n` +
        `  display:      ${cfg.displayName}\n` +
        `  gateway:      ${cfg.gatewayName}\n` +
        `  platform:     ${cfg.platform} (detected: ${detectPlatform()})\n` +
        `  paired since: ${cfg.firstConnectedAt}\n` +
        `  token:        ${redactToken(cfg.token)}\n` +
        toolsLine,
    );
    return 0;
  } catch (err) {
    process.stderr.write(
      `${PROG}: status error: ${err instanceof Error ? err.message : err}\n`,
    );
    return 1;
  }
}

async function cmdRotate(
  flags: Record<string, string | true>,
): Promise<number> {
  const configPath = strFlag(flags, 'config', false) ?? defaultConfigPath();
  const cfg = await loadConfig(configPath);
  if (!cfg) {
    process.stderr.write(`${PROG}: not paired — nothing to rotate.\n`);
    return 5;
  }
  const url = `${trimSlash(cfg.serverUrl)}/api/remote-devices/${encodeURIComponent(cfg.deviceId)}/rotate`;
  try {
    // Authenticate the rotate call using the current bearer token —
    // the gateway's master-policy gate accepts a device's own token as
    // proof of self for rotation (see doc 37 §5.2 / §6.2-rotate).
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${cfg.token}`,
      },
    });
    if (!res.ok) {
      process.stderr.write(
        `${PROG}: rotate HTTP ${res.status} ${res.statusText}\n`,
      );
      return 4;
    }
    const body = (await res.json()) as { token?: string };
    if (typeof body.token !== 'string') {
      process.stderr.write(
        `${PROG}: rotate response missing 'token' field\n`,
      );
      return 4;
    }
    const { saveConfig } = await import('./config.js');
    await saveConfig({ ...cfg, token: body.token }, configPath);
    process.stdout.write(
      `Rotated. New token written to ${configPath} (not echoed).\n`,
    );
    return 0;
  } catch (err) {
    process.stderr.write(
      `${PROG}: rotate failed: ${err instanceof Error ? err.message : err}\n`,
    );
    return 3;
  }
}

async function cmdForget(
  flags: Record<string, string | true>,
): Promise<number> {
  const configPath = strFlag(flags, 'config', false) ?? defaultConfigPath();
  await deleteConfig(configPath);
  process.stdout.write(
    `Local config at ${configPath} removed. (Server-side device record NOT revoked — use \`swarmai device kick <id>\` from the gateway.)\n`,
  );
  return 0;
}

// ---------------------------------------------------------------------
//  Helpers
// ---------------------------------------------------------------------

function strFlag(
  flags: Record<string, string | true>,
  key: string,
  required = true,
): string | undefined {
  const v = flags[key];
  if (v === undefined || v === true) {
    if (required && v !== undefined) {
      throw new Error(`--${key} requires a value`);
    }
    return undefined;
  }
  return v;
}

function defaultDisplayName(): string {
  // Best-effort hostname; falls back to a generic label so we never
  // leak a real hostname when one isn't available.
  try {
    const hn = hostname();
    return typeof hn === 'string' && hn.length > 0 ? hn : 'device';
  } catch {
    return 'device';
  }
}

function redactToken(token: string): string {
  if (token.length <= 8) return '***';
  return `${token.slice(0, 4)}…${token.slice(-2)} (${token.length} chars)`;
}

function trimSlash(s: string): string {
  return s.endsWith('/') ? s.slice(0, -1) : s;
}

// ---------------------------------------------------------------------
//  Entry
// ---------------------------------------------------------------------

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const { command, flags } = parseArgs(argv);

  // Top-level short-circuits.
  if (
    command === '' ||
    command === 'help' ||
    flags['help'] === true ||
    flags['h'] === true
  ) {
    printHelp();
    return command === '' ? 1 : 0;
  }
  if (command === '--version' || flags['version'] === true) {
    printVersion();
    return 0;
  }

  switch (command) {
    case 'pair':
      return cmdPair(flags);
    case 'run':
      return cmdRun(flags);
    case 'status':
      return cmdStatus();
    case 'rotate':
      return cmdRotate(flags);
    case 'forget':
      return cmdForget(flags);
    default:
      process.stderr.write(
        `${PROG}: unknown command: ${command}\nRun \`${PROG} --help\` for usage.\n`,
      );
      return 2;
  }
}

main().then(
  (code) => {
    // Don't force-exit when code is 0 and run() returned — `run` keeps
    // the process alive via the open WebSocket. process.exit(0) here
    // would tear down an active connection.
    if (code !== 0) {
      process.exit(code);
    }
  },
  (err) => {
    process.stderr.write(
      `${PROG}: unhandled error: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`,
    );
    process.exit(1);
  },
);
