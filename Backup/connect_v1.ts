/**
 * WebSocket client lifecycle for the device-agent (doc 37 §2).
 *
 * Responsibilities:
 *   1. Open WS to `${serverUrl}/ws/device-agent` with the bearer
 *      sub-protocol `bearer.<token>` (NOT a query param — token never
 *      hits HTTP access logs that way).
 *   2. On open, wait for the server's `welcome` notification (sent
 *      first per the spec), then send `device/announce` with the local
 *      tool catalog.
 *   3. Start the heartbeat (30s).
 *   4. Dispatch inbound `tool/invoke` → `processInvocation()` → send
 *      `tool/result` back. Tool invocations run concurrently — we
 *      don't await one before accepting the next.
 *   5. On socket close, schedule reconnect with exponential backoff:
 *      1s, 2s, 4s, 8s, 16s, 32s, capped at 60s. Jitter ±20% to avoid
 *      thundering herds against a recovering gateway.
 *   6. Graceful shutdown via `close()`: send `device/disconnect`
 *      notification, wait up to 2s for in-flight invocations to settle,
 *      then close the socket. SIGINT/SIGTERM wiring lives in main.ts.
 *
 * Connection generation: every successful open bumps `generation`.
 * Inbound `tool/invoke` frames from an older generation (shouldn't
 * happen on a single socket, but defensive vs replay over reconnect)
 * are dropped — see doc 37 §7.
 */
import { WebSocket } from 'ws';
import type { RawData } from 'ws';
import pkg from '../package.json' with { type: 'json' };
const pkgName = pkg.name;
const pkgVersion = pkg.version;
import { snapshotCatalog } from './catalog.js';
import {
  encodeFrame,
  notification,
  parseFrame,
  DeviceMethods,
  ServerMethods,
  successResponse,
  type DeviceAnnounceParams,
  type DeviceHeartbeatParams,
  type ToolInvokeParams,
  type ToolResultParams,
  type WelcomeParams,
} from './protocol.js';
import { startHeartbeat, type HeartbeatHandle } from './heartbeat.js';
import { InvocationTracker, processInvocation } from './invoke.js';
import type { DeviceConfig } from './config.js';

export const DEFAULT_RECONNECT_BACKOFF_MAX_MS = 60_000;
export const DEFAULT_INITIAL_RECONNECT_MS = 1_000;
export const DEFAULT_SHUTDOWN_DRAIN_MS = 2_000;

// Silence "imported but unused" when we only reference for side-effect.
void pkgName;

export interface ConnectionOptions {
  config: DeviceConfig;
  /** Override the agent version reported in `device/announce`. */
  agentVersion?: string;
  /** Override the initial backoff (default 1s). */
  initialBackoffMs?: number;
  /** Cap the exponential backoff (default 60s). */
  maxBackoffMs?: number;
  /** Heartbeat interval (default 30s). */
  heartbeatIntervalMs?: number;
  /** Drain timeout on graceful shutdown (default 2s). */
  shutdownDrainMs?: number;
}

export interface ConnectionHandle {
  /** Trigger graceful shutdown. Idempotent. */
  close(): Promise<void>;
  /** Resolves when the WS-lifetime loop exits (closed AND no further
   *  reconnect scheduled). */
  done: Promise<void>;
}

export function startConnection(opts: ConnectionOptions): ConnectionHandle {
  const tracker = new InvocationTracker();
  let stopped = false;
  let currentSocket: WebSocket | undefined;
  let heartbeat: HeartbeatHandle | undefined;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let generation = 0;
  let attemptCount = 0;

  const initial = opts.initialBackoffMs ?? DEFAULT_INITIAL_RECONNECT_MS;
  const cap = opts.maxBackoffMs ?? DEFAULT_RECONNECT_BACKOFF_MAX_MS;
  const drainMs = opts.shutdownDrainMs ?? DEFAULT_SHUTDOWN_DRAIN_MS;
  const agentVersion = opts.agentVersion ?? pkgVersion;

  const doneSentinel = { resolve: () => {} };
  const done = new Promise<void>((resolve) => {
    doneSentinel.resolve = resolve;
  });

  function scheduleReconnect(): void {
    if (stopped) {
      doneSentinel.resolve();
      return;
    }
    const exp = Math.min(cap, initial * 2 ** Math.min(attemptCount, 16));
    const jitter = exp * (0.8 + Math.random() * 0.4); // ±20%
    const delay = Math.max(initial, Math.round(jitter));
    attemptCount += 1;
    console.log(
      `[device-agent] reconnect attempt ${attemptCount} in ${delay}ms`,
    );
    reconnectTimer = setTimeout(openOnce, delay);
    if (typeof (reconnectTimer as { unref?: () => void }).unref === 'function') {
      (reconnectTimer as { unref: () => void }).unref();
    }
  }

  function openOnce(): void {
    if (stopped) {
      doneSentinel.resolve();
      return;
    }
    generation += 1;
    const myGen = generation;
    const wsUrl = wsEndpoint(opts.config.serverUrl);
    console.log(
      `[device-agent] connecting to ${wsUrl} (gen=${myGen}, device=${opts.config.deviceId})`,
    );

    let ws: WebSocket;
    try {
      // Subprotocol carries the bearer token. Per RFC 6455 subprotocols
      // are tokens (must match /[!#$%&'*+\-.^_`|~0-9A-Za-z]+/) — the
      // gateway-issued token is URL-safe base64 which already satisfies
      // this. Browsers can't customise WS headers, but the `ws` Node
      // client does it natively here.
      ws = new WebSocket(wsUrl, [`bearer.${opts.config.token}`]);
    } catch (err) {
      console.error(
        `[device-agent] WS construction failed: ${
          err instanceof Error ? err.message : err
        }`,
      );
      scheduleReconnect();
      return;
    }

    currentSocket = ws;

    let opened = false;
    let receivedWelcome = false;

    ws.on('open', () => {
      opened = true;
      // Reset attempt counter on successful open so future losses start
      // a fresh backoff curve.
      attemptCount = 0;
      console.log(`[device-agent] WS open (gen=${myGen})`);
    });

    ws.on('message', async (data: RawData) => {
      if (currentSocket !== ws) return; // stale frame from prior gen
      const text = bufferToString(data);
      let parsed;
      try {
        parsed = parseFrame(text);
      } catch (err) {
        console.warn(
          `[device-agent] dropped malformed frame: ${
            err instanceof Error ? err.message : err
          }`,
        );
        return;
      }

      try {
        if (parsed.kind === 'notification') {
          await handleNotification(parsed.message.method, parsed.message.params, {
            ws,
            tracker,
            config: opts.config,
            agentVersion,
            onWelcome: () => {
              if (receivedWelcome) return;
              receivedWelcome = true;
              void sendAnnounce(ws, opts.config, agentVersion);
              heartbeat?.stop();
              heartbeat = startHeartbeat({
                send: (params: DeviceHeartbeatParams) =>
                  safeSend(ws, encodeFrame(notification(DeviceMethods.Heartbeat, params))),
                tracker,
                intervalMs: opts.heartbeatIntervalMs,
              });
            },
          });
        } else if (parsed.kind === 'request') {
          await handleRequest(parsed.message, {
            ws,
            tracker,
            config: opts.config,
          });
        }
        // Responses to our own requests: we don't currently send any
        // request frames device→server, so a stray response is ignored.
      } catch (err) {
        console.error(
          `[device-agent] frame handler threw: ${
            err instanceof Error ? err.message : err
          }`,
        );
      }
    });

    ws.on('error', (err: Error) => {
      // 'error' is followed by 'close' — log here and let close drive reconnect.
      console.warn(`[device-agent] WS error (gen=${myGen}): ${err.message}`);
    });

    ws.on('unexpected-response', (_req, res) => {
      // HTTP-level rejection (401/403/404). Log status and let close run.
      console.warn(
        `[device-agent] WS upgrade rejected (gen=${myGen}): HTTP ${res.statusCode}`,
      );
    });

    ws.on('close', (code, reasonBuf) => {
      const reason = bufferToString(reasonBuf);
      console.log(
        `[device-agent] WS closed (gen=${myGen}, code=${code}${
          reason ? `, reason="${reason}"` : ''
        })`,
      );
      if (currentSocket === ws) {
        currentSocket = undefined;
        heartbeat?.stop();
        heartbeat = undefined;
      }
      if (stopped) {
        doneSentinel.resolve();
        return;
      }
      // If we never opened, exponential backoff still applies; if we
      // opened then dropped, we already reset attemptCount on open so
      // the next attempt restarts at `initial`.
      void opened; // silence unused-var lint
      scheduleReconnect();
    });
  }

  // Kick off the first connection asynchronously so callers can await
  // `handle.done` from a tick where they've already wired SIGINT etc.
  setImmediate(openOnce);

  return {
    close: async () => {
      if (stopped) return;
      stopped = true;
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = undefined;
      }
      heartbeat?.stop();
      heartbeat = undefined;
      const ws = currentSocket;
      if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
        try {
          if (ws.readyState === WebSocket.OPEN) {
            safeSend(
              ws,
              encodeFrame(
                notification(DeviceMethods.Disconnect, {
                  reason: 'client-shutdown',
                }),
              ),
            );
          }
        } catch {
          /* ignore — we're already tearing down */
        }
        // Wait briefly for in-flight invocations to drain.
        const deadline = Date.now() + drainMs;
        while (tracker.count() > 0 && Date.now() < deadline) {
          await delay(50);
        }
        try {
          ws.close(1000, 'client-shutdown');
        } catch {
          /* ignore */
        }
      }
      doneSentinel.resolve();
      await done;
    },
    done,
  };
}

// ---------------------------------------------------------------------
//  Handlers
// ---------------------------------------------------------------------

interface NotificationCtx {
  ws: WebSocket;
  tracker: InvocationTracker;
  config: DeviceConfig;
  agentVersion: string;
  onWelcome: () => void;
}

async function handleNotification(
  method: string,
  params: unknown,
  ctx: NotificationCtx,
): Promise<void> {
  switch (method) {
    case ServerMethods.Welcome: {
      const welcome = params as Partial<WelcomeParams> | undefined;
      console.log(
        `[device-agent] welcome from gateway "${welcome?.gatewayName ?? 'unknown'}" (server v${welcome?.serverVersion ?? '?'})`,
      );
      ctx.onWelcome();
      return;
    }
    case ServerMethods.DeviceDisconnect: {
      const reason =
        (params as { reason?: string } | undefined)?.reason ?? 'unspecified';
      console.warn(`[device-agent] server requested disconnect: ${reason}`);
      // The server is asking us to leave. Close the socket; the close
      // handler will schedule a reconnect — but if the server revoked
      // our token the upgrade will fail with 401 and we'll keep
      // retrying with backoff until the operator re-pairs.
      try {
        ctx.ws.close(1000, 'server-requested-disconnect');
      } catch {
        /* ignore */
      }
      return;
    }
    default:
      console.warn(`[device-agent] ignored unknown notification: ${method}`);
  }
}

interface RequestCtx {
  ws: WebSocket;
  tracker: InvocationTracker;
  config: DeviceConfig;
}

async function handleRequest(
  msg: { id: unknown; method: string; params?: unknown },
  ctx: RequestCtx,
): Promise<void> {
  const id = msg.id as null | string | number;
  switch (msg.method) {
    case ServerMethods.ToolInvoke: {
      const params = msg.params as ToolInvokeParams;
      // Per doc 37 §2.3: ack the request synchronously with `null`,
      // then send the real outcome as a `tool/result` notification
      // (because tool execution may take minutes).
      safeSend(ctx.ws, encodeFrame(successResponse(id, null)));

      // Don't await — let multiple invocations run concurrently.
      void (async () => {
        const result = await processInvocation(
          params,
          {
            sessionId: `wsgen-${ctx.config.deviceId}`,
            deviceId: ctx.config.deviceId,
          },
          ctx.tracker,
        );
        safeSend(
          ctx.ws,
          encodeFrame(notification(DeviceMethods.ToolResult, result satisfies ToolResultParams)),
        );
      })();
      return;
    }
    case ServerMethods.DevicePing: {
      const token = (msg.params as { token?: unknown } | undefined)?.token ?? null;
      safeSend(
        ctx.ws,
        encodeFrame(
          successResponse(id, { token, ts: new Date().toISOString() }),
        ),
      );
      return;
    }
    default:
      safeSend(
        ctx.ws,
        encodeFrame({
          jsonrpc: '2.0',
          id,
          error: {
            code: -32601,
            message: `method not found: ${msg.method}`,
          },
        }),
      );
  }
}

// ---------------------------------------------------------------------
//  Helpers
// ---------------------------------------------------------------------

async function sendAnnounce(
  ws: WebSocket,
  cfg: DeviceConfig,
  agentVersion: string,
): Promise<void> {
  let tools: Awaited<ReturnType<typeof snapshotCatalog>> = [];
  try {
    tools = await snapshotCatalog();
  } catch (err) {
    console.warn(
      `[device-agent] snapshotCatalog failed (announcing empty list): ${
        err instanceof Error ? err.message : err
      }`,
    );
  }
  const params: DeviceAnnounceParams = {
    deviceId: cfg.deviceId,
    displayName: cfg.displayName,
    platform: cfg.platform,
    agentVersion,
    tools,
  };
  console.log(
    `[device-agent] announcing ${tools.length} tools to gateway "${cfg.gatewayName}"`,
  );
  safeSend(ws, encodeFrame(notification(DeviceMethods.Announce, params)));
}

function safeSend(ws: WebSocket, frame: string): void {
  if (ws.readyState !== WebSocket.OPEN) return;
  try {
    ws.send(frame);
  } catch (err) {
    console.warn(
      `[device-agent] send failed: ${err instanceof Error ? err.message : err}`,
    );
  }
}

function bufferToString(data: RawData | Buffer): string {
  if (typeof data === 'string') return data;
  if (Buffer.isBuffer(data)) return data.toString('utf8');
  if (Array.isArray(data)) {
    return Buffer.concat(data as Buffer[]).toString('utf8');
  }
  // ArrayBuffer
  return Buffer.from(data as ArrayBuffer).toString('utf8');
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    if (typeof (t as { unref?: () => void }).unref === 'function') {
      (t as { unref: () => void }).unref();
    }
  });
}

/**
 * Convert `http(s)://host[:port]/...base` into the WS endpoint used by
 * the gateway: `ws(s)://host[:port]/ws/device-agent`. Preserves the
 * scheme upgrade (http→ws, https→wss).
 */
export function wsEndpoint(serverUrl: string): string {
  let url: URL;
  try {
    url = new URL(serverUrl);
  } catch {
    // Last-resort fallback — operator probably pasted "localhost:7910".
    return `ws://${serverUrl.replace(/^\/+|\/+$/g, '')}/ws/device-agent`;
  }
  const wsProto = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${wsProto}//${url.host}/ws/device-agent`;
}
