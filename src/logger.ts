/**
 * Structured terminal logger for the device-agent daemon.
 *
 * Three verbosity levels:
 *   - `quiet`   → errors only.
 *   - `normal`  → state transitions, tool invocations, tool results,
 *                 important lifecycle events (connect/disconnect/pair).
 *   - `verbose` → everything in normal + heartbeats, reconnect attempts,
 *                 raw frame previews (truncated).
 *
 * The default verbosity (when no flag is set) is `normal` and MUST remain
 * a strict superset of the previous default — operators upgrading from
 * an older daemon should never see *less* than before.
 *
 * Output format example:
 *
 *   [14:23:11] ●  connected to https://my-gateway.example.com (deviceId: dev_abc12345)
 *   [14:23:11] →  device/announce — 18 tools
 *   [14:23:42] ←  tool/invoke   clipboard_read       (inv_a1b2)
 *   [14:23:42] →  tool/result   ok                   (inv_a1b2, 12ms)
 *   [14:25:01] ●  disconnect    server-shutdown
 *   [14:25:01] ↻  reconnect in 1.0s
 *
 * Colour rules:
 *   - ●  cyan    state
 *   - →  green   outbound
 *   - ←  blue    inbound
 *   - ↻  yellow  reconnect/retry
 *   - error lines: red
 *
 * Colours are emitted as raw ANSI escapes (no `chalk` / `picocolors`
 * dependency — keeps the bundle lean). Stripped when:
 *   - `process.env.NO_COLOR` is set (any non-empty value), OR
 *   - stdout/stderr is not a TTY.
 *
 * Security: this module NEVER receives the bearer token or pair code.
 * Callers must scrub secrets before invoking the logger — the logger
 * itself does no additional redaction. The bearer token rides only in
 * the WS subprotocol (never in JSON-RPC bodies), and pair codes are
 * masked at the `pair.ts` boundary before any string reaches us.
 */

export type LogLevel = 'quiet' | 'normal' | 'verbose';

export interface Logger {
  /** State transitions: connect, disconnect, pair, reconnect-scheduled. */
  state(msg: string, meta?: Record<string, unknown>): void;
  /** Inbound from gateway: tool/invoke, device/ping, device/disconnect. */
  rx(method: string, body: string, meta?: { invocationId?: string }): void;
  /**
   * Outbound to gateway: device/announce, tool/result, device/heartbeat.
   * `durationMs` (when given) is appended to the line so operators can
   * see tool latency at a glance.
   */
  tx(
    method: string,
    body: string,
    meta?: { invocationId?: string; durationMs?: number },
  ): void;
  /** Heartbeat-rate events — only shown in verbose. */
  beat(msg: string, meta?: Record<string, unknown>): void;
  /** Errors — always shown, regardless of level. */
  error(msg: string, err?: unknown): void;
  /** The active log level (for callers that want to gate work cheaply). */
  readonly level: LogLevel;
  /** Whether verbose-only output should be emitted. */
  readonly verbose: boolean;
}

// ---------------------------------------------------------------------
//  ANSI helpers (plain escapes — no runtime dependency)
// ---------------------------------------------------------------------

const ANSI = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
  gray: '\x1b[90m',
};

/** Width to which tool/method names are padded for column alignment. */
const METHOD_PAD = 16;
/** Width to which the "body" cell is padded so the meta suffix lines up. */
const BODY_PAD = 24;
/** Max body length printed inline before being truncated with an ellipsis. */
const BODY_MAX = 120;

function shouldColour(): boolean {
  // NO_COLOR convention: any non-empty value disables colour.
  if (process.env.NO_COLOR && process.env.NO_COLOR.length > 0) return false;
  // Only colour TTYs. Bundled-mode operators frequently redirect stdout
  // to a log file; emitting escapes there would garble the file.
  const stream = process.stdout as NodeJS.WriteStream & {
    isTTY?: boolean;
  };
  return Boolean(stream && stream.isTTY);
}

function paint(colour: string, useColour: boolean): (s: string) => string {
  return useColour ? (s: string) => `${colour}${s}${ANSI.reset}` : (s: string) => s;
}

function timestamp(): string {
  const d = new Date();
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}

/** Truncate a string to `max` characters, appending an ellipsis when cut. */
export function truncate(s: string, max = BODY_MAX): string {
  if (s.length <= max) return s;
  // U+2026 HORIZONTAL ELLIPSIS — one cell instead of three dots.
  return `${s.slice(0, max - 1)}…`;
}

/** Pad a string to a fixed width with trailing spaces (left-aligned). */
function padRight(s: string, width: number): string {
  return s.length >= width ? s : s + ' '.repeat(width - s.length);
}

/**
 * Serialise an arbitrary value for inline display. Wraps the
 * truncate() call so JSON-Stringify failure (circular refs, BigInt)
 * never crashes the logger.
 */
export function previewJson(value: unknown, max = BODY_MAX): string {
  try {
    return truncate(JSON.stringify(value) ?? String(value), max);
  } catch {
    try {
      return truncate(String(value), max);
    } catch {
      return '<unstringifiable>';
    }
  }
}

// ---------------------------------------------------------------------
//  Logger factory
// ---------------------------------------------------------------------

/**
 * Build a logger for the given level. Reads colour-support state ONCE
 * at construction time — callers that flip `NO_COLOR` after start get
 * the original behaviour. (Acceptable: env changes mid-process are
 * unusual for a daemon.)
 */
export function createLogger(level: LogLevel): Logger {
  const useColour = shouldColour();
  const c = {
    dim: paint(ANSI.dim, useColour),
    gray: paint(ANSI.gray, useColour),
    red: paint(ANSI.red, useColour),
    green: paint(ANSI.green, useColour),
    yellow: paint(ANSI.yellow, useColour),
    blue: paint(ANSI.blue, useColour),
    cyan: paint(ANSI.cyan, useColour),
  };

  function ts(): string {
    return c.gray(`[${timestamp()}]`);
  }

  function writeLine(s: string): void {
    // Always trailing newline; one frame per line for easy `tail -f`.
    process.stdout.write(`${s}\n`);
  }

  function writeErrLine(s: string): void {
    process.stderr.write(`${s}\n`);
  }

  function formatMeta(
    meta: { invocationId?: string; durationMs?: number } | undefined,
  ): string {
    if (!meta) return '';
    const parts: string[] = [];
    if (meta.invocationId) parts.push(meta.invocationId);
    if (typeof meta.durationMs === 'number' && Number.isFinite(meta.durationMs)) {
      parts.push(`${meta.durationMs}ms`);
    }
    if (parts.length === 0) return '';
    return c.dim(`(${parts.join(', ')})`);
  }

  function formatExtra(meta: Record<string, unknown> | undefined): string {
    if (!meta || Object.keys(meta).length === 0) return '';
    return c.dim(previewJson(meta));
  }

  const logger: Logger = {
    get level() {
      return level;
    },
    get verbose() {
      return level === 'verbose';
    },

    state(msg, meta) {
      if (level === 'quiet') return;
      const sigil = c.cyan('●'); // ●
      const extra = formatExtra(meta);
      writeLine(`${ts()} ${sigil}  ${msg}${extra ? '  ' + extra : ''}`);
    },

    rx(method, body, meta) {
      if (level === 'quiet') return;
      const sigil = c.blue('←'); // ←
      const m = padRight(method, METHOD_PAD);
      const b = padRight(truncate(body, BODY_MAX), BODY_PAD);
      const metaStr = formatMeta(meta);
      writeLine(`${ts()} ${sigil}  ${m} ${b}${metaStr ? ' ' + metaStr : ''}`);
    },

    tx(method, body, meta) {
      if (level === 'quiet') return;
      const sigil = c.green('→'); // →
      const m = padRight(method, METHOD_PAD);
      const b = padRight(truncate(body, BODY_MAX), BODY_PAD);
      const metaStr = formatMeta(meta);
      writeLine(`${ts()} ${sigil}  ${m} ${b}${metaStr ? ' ' + metaStr : ''}`);
    },

    beat(msg, meta) {
      if (level !== 'verbose') return;
      const sigil = c.dim('∙'); // ∙ (subtle bullet for low-noise)
      const extra = formatExtra(meta);
      writeLine(`${ts()} ${sigil}  ${c.dim(msg)}${extra ? '  ' + extra : ''}`);
    },

    error(msg, err) {
      const sigil = c.red('✗'); // ✗
      let detail = '';
      if (err !== undefined) {
        if (err instanceof Error) {
          detail = `: ${err.message}`;
        } else if (typeof err === 'string') {
          detail = `: ${err}`;
        } else {
          detail = `: ${previewJson(err)}`;
        }
      }
      writeErrLine(`${ts()} ${sigil}  ${c.red(msg)}${detail}`);
    },
  };

  return logger;
}

// ---------------------------------------------------------------------
//  Reconnect-line helper (used by connect.ts for the ↻ sigil)
// ---------------------------------------------------------------------

/**
 * Format a reconnect-scheduled line. Kept separate from `state()` so we
 * can use the dedicated ↻ sigil + yellow colour without bloating the
 * Logger surface. Falls back to a no-op when `quiet` (errors only).
 */
export function logReconnect(
  logger: Logger,
  delayMs: number,
  attempt: number,
): void {
  if (logger.level === 'quiet') return;
  const useColour = shouldColour();
  const arrow = useColour ? `${ANSI.yellow}↻${ANSI.reset}` : '↻';
  const ts = useColour
    ? `${ANSI.gray}[${timestamp()}]${ANSI.reset}`
    : `[${timestamp()}]`;
  const seconds = (delayMs / 1000).toFixed(1);
  const tail = useColour
    ? `${ANSI.dim}(attempt ${attempt})${ANSI.reset}`
    : `(attempt ${attempt})`;
  process.stdout.write(`${ts} ${arrow}  reconnect in ${seconds}s ${tail}\n`);
}

/**
 * Bytes → human-readable size (1.2KB, 3.4MB). Used to summarise large
 * tool-result payloads (screenshots, audio captures) without flooding
 * the terminal with base64.
 */
export function humanBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '0B';
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)}MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(1)}GB`;
}
