/**
 * JSON-RPC 2.0 frame helpers + verb constants for the device-agent
 * wire protocol (doc 37 §2).
 *
 * Frames are full JSON objects (one per WebSocket message), no newline
 * framing — `ws` already delimits messages for us.
 *
 * We keep this thin (~100 lines) rather than pulling in `vscode-jsonrpc`
 * or similar — the spec we need is small and the dependency budget for
 * a daemon binary matters (smaller bundle, fewer transitive surprises
 * on Termux / locked-down hosts).
 */

export const JSON_RPC_VERSION = '2.0' as const;

// ---------------------------------------------------------------------
//  Verb names — single source of truth so typos surface at compile time
// ---------------------------------------------------------------------

/** Server → device methods (received by us). */
export const ServerMethods = {
  Welcome: 'welcome',
  ToolInvoke: 'tool/invoke',
  DeviceDisconnect: 'device/disconnect',
  DevicePing: 'device/ping',
} as const;

/** Device → server methods (sent by us). */
export const DeviceMethods = {
  Announce: 'device/announce',
  ToolResult: 'tool/result',
  Heartbeat: 'device/heartbeat',
  ToolsChanged: 'device/tools-changed',
  Disconnect: 'device/disconnect',
} as const;

// ---------------------------------------------------------------------
//  Wire shapes (matches doc 37 §2 exactly — don't add fields here
//  without amending the doc + server-side @swarmai/device-registry).
// ---------------------------------------------------------------------

export type JsonRpcId = string | number | null;

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: JsonRpcId;
  method: string;
  params?: unknown;
}

export interface JsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params?: unknown;
}

export interface JsonRpcSuccessResponse {
  jsonrpc: '2.0';
  id: JsonRpcId;
  result: unknown;
}

export interface JsonRpcErrorResponse {
  jsonrpc: '2.0';
  id: JsonRpcId;
  error: { code: number; message: string; data?: unknown };
}

export type JsonRpcResponse = JsonRpcSuccessResponse | JsonRpcErrorResponse;

export type ParsedFrame =
  | { kind: 'request'; message: JsonRpcRequest }
  | { kind: 'notification'; message: JsonRpcNotification }
  | { kind: 'response'; message: JsonRpcResponse };

/** Single tool descriptor sent in `device/announce` (doc 37 §2.2). */
export interface ToolDescriptor {
  name: string;
  toolset: string;
  description: string;
  policy: 'open' | 'pair-gated' | 'master';
  schema: Record<string, unknown>; // JSON-Schema-shaped
  source?: { kind: 'plugin'; pluginId: string };
}

/** Params for `device/announce`. */
export interface DeviceAnnounceParams {
  deviceId: string;
  displayName: string;
  platform: 'darwin' | 'linux' | 'win32' | 'android' | 'wsl';
  agentVersion: string;
  tools: ToolDescriptor[];
}

/** Params for `device/heartbeat`. */
export interface DeviceHeartbeatParams {
  stats: {
    cpuPct?: number;
    memMB?: number;
    uptimeSec: number;
    inflightInvocations: number;
  };
}

/** Params for inbound `tool/invoke`. */
export interface ToolInvokeParams {
  invocationId: string;
  toolName: string;
  args: unknown;
  timeoutMs?: number;
  actor: { userId: string; scope: string };
}

/** Params for outbound `tool/result`. */
export type ToolResultParams =
  | { invocationId: string; ok: true; result: unknown }
  | {
      invocationId: string;
      ok: false;
      error: { code: string; message: string; detail?: unknown };
    };

/** Welcome notification from the server on accept. */
export interface WelcomeParams {
  deviceId: string;
  serverVersion: string;
  gatewayName: string;
}

// ---------------------------------------------------------------------
//  Frame constructors
// ---------------------------------------------------------------------

export function notification(
  method: string,
  params: unknown,
): JsonRpcNotification {
  const msg: JsonRpcNotification = { jsonrpc: JSON_RPC_VERSION, method };
  if (params !== undefined) msg.params = params;
  return msg;
}

export function successResponse(
  id: JsonRpcId,
  result: unknown,
): JsonRpcSuccessResponse {
  return { jsonrpc: JSON_RPC_VERSION, id, result: result ?? null };
}

export function errorResponse(
  id: JsonRpcId,
  code: number,
  message: string,
  data?: unknown,
): JsonRpcErrorResponse {
  const err: JsonRpcErrorResponse['error'] = { code, message };
  if (data !== undefined) err.data = data;
  return { jsonrpc: JSON_RPC_VERSION, id, error: err };
}

export function encodeFrame(
  msg: JsonRpcRequest | JsonRpcNotification | JsonRpcResponse,
): string {
  return JSON.stringify(msg);
}

/**
 * Parse a raw on-wire frame. Returns a discriminated union or throws
 * if the JSON is malformed / not JSON-RPC 2.0.
 */
export function parseFrame(frame: string): ParsedFrame {
  let raw: unknown;
  try {
    raw = JSON.parse(frame);
  } catch (err) {
    throw new Error(
      `device-agent: invalid JSON frame: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('device-agent: frame must be a JSON object');
  }
  const obj = raw as Record<string, unknown>;
  if (obj.jsonrpc !== JSON_RPC_VERSION) {
    throw new Error(
      `device-agent: unexpected jsonrpc version: ${String(obj.jsonrpc)}`,
    );
  }
  if ('result' in obj || 'error' in obj) {
    return { kind: 'response', message: obj as unknown as JsonRpcResponse };
  }
  if ('id' in obj) {
    return { kind: 'request', message: obj as unknown as JsonRpcRequest };
  }
  return {
    kind: 'notification',
    message: obj as unknown as JsonRpcNotification,
  };
}
