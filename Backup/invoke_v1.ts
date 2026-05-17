/**
 * Process a `tool/invoke` request: dispatch via the in-process
 * @swarmai/tools registry, collect the result, and build a `tool/result`
 * notification payload (doc 37 §2.2 + §6.3).
 *
 * The registry's `dispatch()` returns a stringified JSON envelope:
 *   - Success: arbitrary string (tool-defined return shape, may not
 *     parse as JSON — we surface as `result: <parsed-or-string>`).
 *   - Error:   `{"ok":false,"error":"...","code":"...","tool":"..."}`
 *
 * We unwrap that envelope and map to the wire `tool/result` shape, so
 * the gateway / remote agent sees a clean discriminated union without
 * having to double-parse the host's internal format.
 */
import type { ToolContext } from '@swarmai/plugin-sdk';
import type {
  ToolInvokeParams,
  ToolResultParams,
} from './protocol.js';

/**
 * Lazy-load the host's tool registry. See catalog.ts for the
 * "why dynamic import" rationale — same applies here.
 */
async function getRegistry(): Promise<{
  dispatch(name: string, rawArgs: string, ctx: ToolContext): Promise<string>;
}> {
  const mod = await import('@swarmai/tools');
  return (mod as unknown as {
    toolRegistry: {
      dispatch(name: string, rawArgs: string, ctx: ToolContext): Promise<string>;
    };
  }).toolRegistry;
}

export interface InvokeDeps {
  /** Stable session id stitched across the daemon's lifetime. */
  sessionId: string;
  /** The device's own id (used as `agentId` in the ToolContext). */
  deviceId: string;
}

/** Track in-flight invocations so heartbeats can report the count. */
export class InvocationTracker {
  private inflight = new Set<string>();

  begin(invocationId: string): void {
    this.inflight.add(invocationId);
  }

  end(invocationId: string): void {
    this.inflight.delete(invocationId);
  }

  count(): number {
    return this.inflight.size;
  }
}

/**
 * Dispatch a tool/invoke and return the corresponding tool/result
 * payload. Never throws — all failure modes are mapped to an `ok: false`
 * result so the wire stays clean.
 */
export async function processInvocation(
  params: ToolInvokeParams,
  deps: InvokeDeps,
  tracker: InvocationTracker,
): Promise<ToolResultParams> {
  const { invocationId, toolName, args, timeoutMs } = params;
  tracker.begin(invocationId);
  try {
    // Build a synthetic ToolContext. The registry uses it for audit +
    // policy checks; on a device the actor is always the remote gateway
    // (we trust the bearer-validated WS) and the "session" is the
    // current daemon connection generation.
    const ctx: ToolContext = {
      sessionId: deps.sessionId,
      agentId: deps.deviceId,
      isMain: false,
      currentTier: 'average',
    };

    const rawArgs = JSON.stringify(args ?? {});
    const toolRegistry = await getRegistry();
    const dispatchPromise = toolRegistry.dispatch(toolName, rawArgs, ctx);

    const effectiveTimeoutMs =
      typeof timeoutMs === 'number' && timeoutMs > 0 ? timeoutMs : 60_000;

    const text = await withTimeout(
      dispatchPromise,
      effectiveTimeoutMs,
      `tool ${toolName} timed out after ${effectiveTimeoutMs}ms`,
    );

    // Try to parse — most tools return JSON strings. Fall back to raw
    // text so non-JSON tools (e.g. `bash` stdout) still flow through.
    let parsed: unknown = text;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }

    // If the parsed envelope is an explicit `{ok:false, ...}` error
    // from the registry's own validation/policy layer, unwrap it.
    if (
      parsed &&
      typeof parsed === 'object' &&
      !Array.isArray(parsed) &&
      (parsed as { ok?: unknown }).ok === false
    ) {
      const env = parsed as {
        error?: string;
        code?: string;
        tool?: string;
        issues?: unknown;
      };
      return {
        invocationId,
        ok: false,
        error: {
          code: env.code ?? 'tool-error',
          message: env.error ?? 'tool returned an error envelope',
          detail: env.issues ?? undefined,
        },
      };
    }

    return { invocationId, ok: true, result: parsed };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const sysCode = (err as { code?: string } | undefined)?.code;
    return {
      invocationId,
      ok: false,
      error: {
        code: typeof sysCode === 'string' ? sysCode.toLowerCase() : 'handler-threw',
        message,
      },
    };
  } finally {
    tracker.end(invocationId);
  }
}

/**
 * Race a promise against a timer. The dispatched tool keeps running
 * after the timeout — we just stop waiting for it (the registry has no
 * cancel surface today, doc 37 §9 has it on roadmap). This keeps the
 * wire side responsive at the cost of a possible late-arriving result.
 */
function withTimeout<T>(
  p: Promise<T>,
  ms: number,
  reason: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(reason));
    }, ms);
    // node:Timer has .unref() — let the timer NOT keep the process alive
    // on its own. Important during graceful shutdown.
    if (typeof (timer as { unref?: () => void }).unref === 'function') {
      (timer as { unref: () => void }).unref();
    }
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}
