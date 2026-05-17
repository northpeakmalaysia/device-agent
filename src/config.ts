/**
 * Persistent device-agent config — `~/.swarmai/device-agent.yaml`.
 *
 * Stored on disk after `pair` succeeds; loaded by `run`. The token is
 * a long-lived bearer credential — file is chmod 0600 on POSIX and the
 * best-effort equivalent on Windows.
 *
 * Shape (doc 37 §6.5):
 *
 *   serverUrl: 'https://my-gateway.example.com'
 *   deviceId: 'dev_abc12345'
 *   displayName: 'phone (Samsung Galaxy S23)'
 *   token: 'urlsafe-base64-32-bytes'
 *   gatewayName: 'main-prod'
 *   firstConnectedAt: '2026-05-17T10:00:00Z'
 */
import { promises as fs, statSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { dirname, join } from 'node:path';
import { parse, stringify } from 'yaml';

export interface DeviceConfig {
  serverUrl: string;
  deviceId: string;
  displayName: string;
  token: string;
  gatewayName: string;
  firstConnectedAt: string;
  /** Platform string as reported at pair time (not auto-detected). */
  platform: 'darwin' | 'linux' | 'win32' | 'android' | 'wsl';
}

/**
 * Default config path. Respects $SWARMAI_DEVICE_AGENT_CONFIG override
 * (useful for tests + multi-tenant hosts that run >1 device agent on
 * the same machine).
 */
export function defaultConfigPath(): string {
  if (process.env.SWARMAI_DEVICE_AGENT_CONFIG) {
    return process.env.SWARMAI_DEVICE_AGENT_CONFIG;
  }
  return join(homedir(), '.swarmai', 'device-agent.yaml');
}

/** Returns null when no config exists yet (not paired). */
export async function loadConfig(
  path: string = defaultConfigPath(),
): Promise<DeviceConfig | null> {
  try {
    const raw = await fs.readFile(path, 'utf8');
    const parsed = parse(raw) as Partial<DeviceConfig> | null;
    if (!parsed || typeof parsed !== 'object') return null;
    // Validate the required fields are present — tolerate extras so we
    // can add optional fields later without breaking older clients.
    const required: (keyof DeviceConfig)[] = [
      'serverUrl',
      'deviceId',
      'token',
      'gatewayName',
      'displayName',
      'firstConnectedAt',
      'platform',
    ];
    for (const k of required) {
      if (typeof parsed[k] !== 'string') {
        throw new Error(
          `device-agent: config at ${path} missing or invalid field: ${k}`,
        );
      }
    }
    return parsed as DeviceConfig;
  } catch (err) {
    const code = (err as { code?: string } | undefined)?.code;
    if (code === 'ENOENT') return null;
    throw err;
  }
}

/**
 * Write the config atomically and apply chmod 0600 on POSIX (best-
 * effort on Windows — Node's fs.chmod works on Windows but only flips
 * the read-only bit; ACLs are not touched).
 */
export async function saveConfig(
  cfg: DeviceConfig,
  path: string = defaultConfigPath(),
): Promise<void> {
  const dir = dirname(path);
  await fs.mkdir(dir, { recursive: true });

  // Stable key order in the YAML output so a `git diff` of a synced
  // config (operators sometimes back this up) is readable.
  const ordered: DeviceConfig = {
    serverUrl: cfg.serverUrl,
    deviceId: cfg.deviceId,
    displayName: cfg.displayName,
    token: cfg.token,
    gatewayName: cfg.gatewayName,
    platform: cfg.platform,
    firstConnectedAt: cfg.firstConnectedAt,
  };
  const yaml = stringify(ordered, { lineWidth: 0 });

  // Write atomically: temp file → rename. fs.rename is atomic on the
  // same filesystem on all supported OSes.
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(tmp, yaml, 'utf8');
  // chmod the temp file BEFORE the rename so there's no window in
  // which the final path exists with world-readable perms.
  await chmod600Best(tmp);
  await fs.rename(tmp, path);

  // Also apply to dirname so future writes inherit reasonable perms.
  if (platform() !== 'win32') {
    try {
      await fs.chmod(dir, 0o700);
    } catch {
      // Already correct, or perms unchangeable — non-fatal.
    }
  }
}

/** Delete the config (used by `forget`). Tolerates ENOENT. */
export async function deleteConfig(
  path: string = defaultConfigPath(),
): Promise<void> {
  try {
    await fs.unlink(path);
  } catch (err) {
    const code = (err as { code?: string } | undefined)?.code;
    if (code !== 'ENOENT') throw err;
  }
}

async function chmod600Best(path: string): Promise<void> {
  try {
    await fs.chmod(path, 0o600);
  } catch {
    // Windows: chmod silently no-ops the user/group/other bits. That's
    // fine — the file lives under the user's profile directory which is
    // already ACL-protected by default. v0.2 will add Windows ACL hardening.
  }
}

/** Sync helper used by `status` (which prints synchronously and doesn't
 *  want to swallow an unhandled rejection). */
export function configExistsSync(path: string = defaultConfigPath()): boolean {
  try {
    statSync(path);
    return true;
  } catch {
    return false;
  }
}
