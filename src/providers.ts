/**
 * Doc 47 — Device-Agent-as-AI-Provider (device side).
 *
 * If this host runs a local LLM backend (Ollama / LM Studio), the device
 * announces it to the gateway (`provider/announce`). The gateway wraps it
 * as a standard provider and — once the operator ENABLES it — can route
 * the Main Agent's reasoning here, so heavy thinking runs on this box's
 * GPU at electricity-bill rates instead of per-token API rates.
 *
 * The device runs NO reasoning loop for these requests: it forwards
 * `provider/chat` straight to the local backend and returns the reply.
 * Tools were already stripped on the gateway before the frame left it.
 *
 * Wire (gateway ↔ device), all over the existing `/ws/device-agent`:
 *   device → gateway  notification  provider/announce { providers }
 *   gateway → device  request       provider/chat   { providerId, payload }
 *   gateway → device  request       provider/list   { providerId }
 *   gateway → device  request       provider/health { providerId }
 *   gateway → device  request       provider/pull   { providerId, model }
 *
 * Dependency-free (global fetch on Node ≥22) — the daemon's bundle budget
 * matters on Termux / locked-down hosts.
 */

const OLLAMA_BASE = (process.env.OLLAMA_HOST ?? 'http://127.0.0.1:11434').replace(/\/+$/, '');
const LMSTUDIO_BASE = (process.env.LMSTUDIO_HOST ?? 'http://127.0.0.1:1234').replace(/\/+$/, '');
const PROBE_TIMEOUT_MS = 2_500;

export interface ProviderModelDescriptor {
  id: string;
  displayName?: string;
  contextWindow?: number;
  capabilities?: { tools?: boolean; vision?: boolean; reasoning?: boolean; embedding?: boolean };
}

export interface ProviderCapabilityDescriptor {
  id: string; // backend kind: 'ollama' | 'lmstudio'
  displayName: string;
  kind: 'ollama' | 'lmstudio' | 'openai-compat';
  reachable: boolean;
  models: ProviderModelDescriptor[];
}

interface ChatResponseWire {
  message: { role: 'assistant'; content: string; reasoning?: string };
  finishReason: 'stop' | 'length' | 'tool_calls' | 'content_filter' | 'error';
  usage: { promptTokens: number; completionTokens: number; totalTokens: number };
}

export interface PullAck {
  status: 'started' | 'already-present' | 'unsupported' | 'error';
  detail?: string;
}

async function fetchJson(
  url: string,
  init: RequestInit & { timeoutMs?: number } = {},
): Promise<unknown> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), init.timeoutMs ?? PROBE_TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...init, signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return (await res.json()) as unknown;
  } finally {
    clearTimeout(timer);
  }
}

function asObj(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

// ---------------------------------------------------------------------
//  Detection — THE operator-tunable heuristic (doc 47 §6).
//
//  Default policy: probe BOTH Ollama and LM Studio; if a backend answers,
//  list its models and announce it. Announce both when both are up — the
//  operator picks which to enable. Tune `MODEL_FILTER` to hide toy models
//  you never want advertised as a heavy-tier brain.
// ---------------------------------------------------------------------

/** Hide models you never want offered as a remote brain (e.g. tiny toys
 *  or embedding-only models). Return false to drop. */
function MODEL_FILTER(id: string): boolean {
  // Drop obvious embedding-only models — they can't serve chat turns.
  if (/embed|bge-|nomic-embed|all-minilm/i.test(id)) return false;
  return true;
}

async function detectOllama(): Promise<ProviderCapabilityDescriptor | null> {
  try {
    const tags = asObj(await fetchJson(`${OLLAMA_BASE}/api/tags`));
    const list = Array.isArray(tags?.['models']) ? (tags!['models'] as unknown[]) : [];
    const models: ProviderModelDescriptor[] = list
      .map(asObj)
      .map((m) => (typeof m?.['name'] === 'string' ? (m['name'] as string) : null))
      .filter((id): id is string => !!id && MODEL_FILTER(id))
      .map((id) => ({ id, displayName: id }));
    return { id: 'ollama', displayName: 'Ollama', kind: 'ollama', reachable: true, models };
  } catch {
    return null;
  }
}

async function detectLmStudio(): Promise<ProviderCapabilityDescriptor | null> {
  try {
    const body = asObj(await fetchJson(`${LMSTUDIO_BASE}/v1/models`));
    const data = Array.isArray(body?.['data']) ? (body!['data'] as unknown[]) : [];
    const models: ProviderModelDescriptor[] = data
      .map(asObj)
      .map((m) => (typeof m?.['id'] === 'string' ? (m['id'] as string) : null))
      .filter((id): id is string => !!id && MODEL_FILTER(id))
      .map((id) => ({ id, displayName: id }));
    return { id: 'lmstudio', displayName: 'LM Studio', kind: 'lmstudio', reachable: true, models };
  } catch {
    return null;
  }
}

/** Scan the local environment for usable LLM backends. */
export async function detectLocalProviders(): Promise<ProviderCapabilityDescriptor[]> {
  const [ollama, lmstudio] = await Promise.all([detectOllama(), detectLmStudio()]);
  return [ollama, lmstudio].filter((p): p is ProviderCapabilityDescriptor => p !== null);
}

// ---------------------------------------------------------------------
//  Serving — provider/chat | provider/list | provider/health | provider/pull
// ---------------------------------------------------------------------

export interface ChatPayload {
  model: string;
  messages: Array<{ role: string; content: unknown }>;
  temperature?: number;
  maxTokens?: number;
  stop?: string[];
  think?: boolean;
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((p) => {
        const o = asObj(p);
        return o && typeof o['text'] === 'string' ? (o['text'] as string) : '';
      })
      .join('');
  }
  return content == null ? '' : String(content);
}

function mapFinish(reason: unknown): ChatResponseWire['finishReason'] {
  if (reason === 'length' || reason === 'max_tokens') return 'length';
  if (reason === 'content_filter') return 'content_filter';
  return 'stop';
}

async function ollamaChat(payload: ChatPayload): Promise<ChatResponseWire> {
  const body = {
    model: payload.model,
    messages: payload.messages.map((m) => ({ role: m.role, content: textOf(m.content) })),
    stream: false,
    think: payload.think === true,
    options: {
      ...(typeof payload.temperature === 'number' ? { temperature: payload.temperature } : {}),
      ...(typeof payload.maxTokens === 'number' ? { num_predict: payload.maxTokens } : {}),
      ...(payload.stop && payload.stop.length ? { stop: payload.stop } : {}),
    },
  };
  const res = asObj(
    await fetchJson(`${OLLAMA_BASE}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      timeoutMs: 170_000,
    }),
  );
  const msg = asObj(res?.['message']);
  const promptTokens = Number(res?.['prompt_eval_count'] ?? 0) || 0;
  const completionTokens = Number(res?.['eval_count'] ?? 0) || 0;
  return {
    message: {
      role: 'assistant',
      content: typeof msg?.['content'] === 'string' ? (msg['content'] as string) : '',
      ...(typeof msg?.['thinking'] === 'string' ? { reasoning: msg['thinking'] as string } : {}),
    },
    finishReason: mapFinish(res?.['done_reason']),
    usage: { promptTokens, completionTokens, totalTokens: promptTokens + completionTokens },
  };
}

async function lmStudioChat(payload: ChatPayload): Promise<ChatResponseWire> {
  const body = {
    model: payload.model,
    messages: payload.messages.map((m) => ({ role: m.role, content: textOf(m.content) })),
    stream: false,
    ...(typeof payload.temperature === 'number' ? { temperature: payload.temperature } : {}),
    ...(typeof payload.maxTokens === 'number' ? { max_tokens: payload.maxTokens } : {}),
    ...(payload.stop && payload.stop.length ? { stop: payload.stop } : {}),
  };
  const res = asObj(
    await fetchJson(`${LMSTUDIO_BASE}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      timeoutMs: 170_000,
    }),
  );
  const choice = asObj(Array.isArray(res?.['choices']) ? (res!['choices'] as unknown[])[0] : null);
  const msg = asObj(choice?.['message']);
  const usage = asObj(res?.['usage']);
  const promptTokens = Number(usage?.['prompt_tokens'] ?? 0) || 0;
  const completionTokens = Number(usage?.['completion_tokens'] ?? 0) || 0;
  return {
    message: {
      role: 'assistant',
      content: typeof msg?.['content'] === 'string' ? (msg['content'] as string) : '',
    },
    finishReason: mapFinish(choice?.['finish_reason']),
    usage: { promptTokens, completionTokens, totalTokens: promptTokens + completionTokens },
  };
}

export async function handleProviderChat(
  providerId: string,
  payload: ChatPayload,
): Promise<ChatResponseWire> {
  if (providerId === 'lmstudio') return lmStudioChat(payload);
  return ollamaChat(payload); // default: ollama
}

export async function handleProviderList(providerId: string): Promise<{ models: ProviderModelDescriptor[] }> {
  const found =
    providerId === 'lmstudio' ? await detectLmStudio() : await detectOllama();
  return { models: found?.models ?? [] };
}

export async function handleProviderHealth(
  providerId: string,
): Promise<{ status: 'ok' | 'degraded' | 'down'; detail?: string }> {
  const found = providerId === 'lmstudio' ? await detectLmStudio() : await detectOllama();
  if (found) return { status: 'ok', detail: `${found.models.length} models` };
  return { status: 'down', detail: `${providerId} not reachable on this device` };
}

/**
 * Pull a model onto the local backend FROM SwarmAI. Acks quickly and
 * downloads in the background; the caller re-announces on completion so
 * the gateway picks up the new model id. LM Studio has no pull API → we
 * report `unsupported` (the operator downloads via the LM Studio UI).
 */
export function handleProviderPull(
  providerId: string,
  model: string,
  onComplete: (ok: boolean, detail: string) => void,
): PullAck {
  if (providerId === 'lmstudio') {
    return { status: 'unsupported', detail: 'LM Studio has no pull API — download via its UI' };
  }
  // Fire-and-forget the Ollama pull; report 'started' immediately.
  void (async () => {
    try {
      // stream:false → one final JSON when the download completes.
      await fetchJson(`${OLLAMA_BASE}/api/pull`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model, stream: false }),
        timeoutMs: 60 * 60_000, // up to 1h for very large models
      });
      onComplete(true, `pulled ${model}`);
    } catch (err) {
      onComplete(false, err instanceof Error ? err.message : String(err));
    }
  })();
  return { status: 'started', detail: `pulling ${model} in background` };
}
