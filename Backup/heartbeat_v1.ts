/**
 * Periodic `device/heartbeat` emitter (doc 37 §2.2).
 *
 * Sends every 30s by default. Stats fields:
 *   - cpuPct: 1-second sample averaged across all cores (best-effort —
 *     omitted on platforms where process.cpuUsage() isn't meaningful).
 *   - memMB: RSS in megabytes from process.memoryUsage().
 *   - uptimeSec: process uptime since daemon start.
 *   - inflightInvocations: from the InvocationTracker.
 */
import { cpuUsage, memoryUsage, uptime } from 'node:process';
import { cpus } from 'node:os';
import { InvocationTracker } from './invoke.js';
import type { DeviceHeartbeatParams } from './protocol.js';

export const DEFAULT_HEARTBEAT_INTERVAL_MS = 30_000;

export interface HeartbeatStarterOptions {
  send: (params: DeviceHeartbeatParams) => void;
  tracker: InvocationTracker;
  intervalMs?: number;
}

export interface HeartbeatHandle {
  stop(): void;
}

export function startHeartbeat(opts: HeartbeatStarterOptions): HeartbeatHandle {
  const intervalMs = opts.intervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
  let prevCpu = cpuUsage();
  let prevAt = Date.now();

  const timer = setInterval(() => {
    const now = Date.now();
    const dt = (now - prevAt) || 1;
    const cur = cpuUsage();
    const elapsedMicros = (cur.user - prevCpu.user) + (cur.system - prevCpu.system);
    prevCpu = cur;
    prevAt = now;

    const coreCount = Math.max(1, cpus().length);
    // CPU% across all cores: micros / (dt_ms * 1000 * cores) * 100
    const cpuPct = Math.max(
      0,
      Math.min(100, (elapsedMicros / (dt * 1000 * coreCount)) * 100),
    );

    const memMB = Math.round(memoryUsage().rss / (1024 * 1024));

    const params: DeviceHeartbeatParams = {
      stats: {
        cpuPct: Number.isFinite(cpuPct) ? Math.round(cpuPct * 10) / 10 : undefined,
        memMB,
        uptimeSec: Math.round(uptime()),
        inflightInvocations: opts.tracker.count(),
      },
    };

    try {
      opts.send(params);
    } catch (err) {
      // Send failure (e.g. WS closed mid-tick) is non-fatal — the
      // connection layer will reconnect and start a fresh heartbeat.
      console.warn(
        `[device-agent] heartbeat send failed: ${
          err instanceof Error ? err.message : err
        }`,
      );
    }
  }, intervalMs);

  // Don't let the heartbeat timer keep the event loop alive on its own —
  // the WS keeps the process up; if it closes we want fast exit.
  if (typeof (timer as { unref?: () => void }).unref === 'function') {
    (timer as { unref: () => void }).unref();
  }

  return {
    stop(): void {
      clearInterval(timer);
    },
  };
}
