/**
 * Pair-redeem flow (doc 37 §3.2). One-shot HTTP POST to the gateway:
 *
 *   POST <serverUrl>/api/remote-devices/pair-redeem
 *   Body: { code, deviceName, platform, agentVersion }
 *   →  200 { deviceId, token, gatewayName, capabilities: {...} }
 *   →  403 { error: 'expired' | 'invalid' | 'already-used' }
 *
 * On success, we persist `{ serverUrl, deviceId, token, displayName,
 * gatewayName, platform, firstConnectedAt }` to the config file and
 * return the redacted summary so `main.ts` can print confirmation.
 *
 * The pair code is a SHORT-LIVED secret — we never log it, only mask
 * as `***` in error messages. The bearer token returned is LONG-LIVED
 * and never gets echoed to stdout (only written to the chmod 0600 file).
 */
import { saveConfig, type DeviceConfig } from './config.js';

export interface PairRedeemRequest {
  serverUrl: string;
  pairCode: string;
  deviceName: string;
  platform: DeviceConfig['platform'];
  agentVersion: string;
}

export interface PairRedeemResponse {
  deviceId: string;
  token: string;
  gatewayName: string;
  capabilities?: { acceptedToolPolicies?: string[] };
}

export interface PairRedeemResult {
  deviceId: string;
  displayName: string;
  gatewayName: string;
  serverUrl: string;
  configPath: string;
}

/**
 * Errors thrown by `pairAndPersist`. `code` is one of the gateway-side
 * sentinel strings so the CLI can render a user-friendly message
 * without parsing free-form text.
 */
export class PairError extends Error {
  constructor(
    public readonly code: 'expired' | 'invalid' | 'already-used' | 'network' | 'unexpected',
    message: string,
  ) {
    super(message);
    this.name = 'PairError';
  }
}

export async function pairAndPersist(
  req: PairRedeemRequest,
  configPath?: string,
): Promise<PairRedeemResult> {
  const url = joinUrl(req.serverUrl, '/api/remote-devices/pair-redeem');

  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        code: req.pairCode,
        deviceName: req.deviceName,
        platform: req.platform,
        agentVersion: req.agentVersion,
      }),
    });
  } catch (err) {
    // Network-level failure (DNS, refused, TLS, etc.). Mask the pair
    // code in any error string we propagate — fetch normally doesn't
    // include it, but be defensive.
    const message = err instanceof Error ? err.message : String(err);
    throw new PairError(
      'network',
      `could not reach gateway at ${url}: ${maskCode(message, req.pairCode)}`,
    );
  }

  // 403 is the gateway's "you used a bad/expired/spent code" surface.
  if (res.status === 403) {
    let body: { error?: string } = {};
    try {
      body = (await res.json()) as { error?: string };
    } catch {
      /* body parse failure — fall through to generic error */
    }
    const code = body.error;
    if (code === 'expired' || code === 'invalid' || code === 'already-used') {
      throw new PairError(code, `pair code rejected: ${code}`);
    }
    throw new PairError(
      'unexpected',
      `pair code rejected (403, no recognised error code in body)`,
    );
  }

  if (!res.ok) {
    let text = '';
    try {
      text = await res.text();
    } catch {
      /* ignore */
    }
    throw new PairError(
      'unexpected',
      `pair-redeem HTTP ${res.status}: ${maskCode(text || res.statusText, req.pairCode)}`,
    );
  }

  let body: PairRedeemResponse;
  try {
    body = (await res.json()) as PairRedeemResponse;
  } catch (err) {
    throw new PairError(
      'unexpected',
      `pair-redeem returned non-JSON: ${err instanceof Error ? err.message : err}`,
    );
  }

  if (
    !body ||
    typeof body.deviceId !== 'string' ||
    typeof body.token !== 'string' ||
    typeof body.gatewayName !== 'string'
  ) {
    throw new PairError(
      'unexpected',
      `pair-redeem response missing required fields (deviceId/token/gatewayName)`,
    );
  }

  const cfg: DeviceConfig = {
    serverUrl: req.serverUrl,
    deviceId: body.deviceId,
    displayName: req.deviceName,
    token: body.token,
    gatewayName: body.gatewayName,
    platform: req.platform,
    firstConnectedAt: new Date().toISOString(),
  };

  await saveConfig(cfg, configPath);

  // Return the redacted summary — caller will format for the user.
  // Token deliberately NOT included; the operator should never see it
  // outside the on-disk config.
  return {
    deviceId: cfg.deviceId,
    displayName: cfg.displayName,
    gatewayName: cfg.gatewayName,
    serverUrl: cfg.serverUrl,
    configPath: configPath ?? '',
  };
}

/**
 * Join a base URL with a relative path, tolerating trailing/leading
 * slashes. Doesn't use `new URL(path, base)` because that surface
 * surprises operators when the base lacks a trailing slash (resolves
 * to the parent dir).
 */
export function joinUrl(base: string, path: string): string {
  const b = base.endsWith('/') ? base.slice(0, -1) : base;
  const p = path.startsWith('/') ? path : `/${path}`;
  return `${b}${p}`;
}

/** Mask occurrences of the pair code in an error string. */
function maskCode(s: string, code: string): string {
  if (!code) return s;
  return s.split(code).join('***');
}
