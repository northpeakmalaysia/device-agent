/**
 * Snapshot the in-process tool registry → ToolDescriptor[] suitable for
 * `device/announce` (doc 37 §2.2).
 *
 * Conversion notes:
 *   - Each ToolDef carries a zod schema. We convert via `zod-to-json-schema`
 *     with `target: 'openAi'` to match the same shape the host uses when
 *     surfacing tools to providers — keeps the JSON Schema fields the
 *     remote agent's reasoning loop expects.
 *   - `schemaOverride` wins when present (mirrors the host's
 *     `ToolRegistry.schemasFor()` behaviour).
 *   - We default `policy: 'open'` when the tool didn't declare one,
 *     same as the host registry's implicit default.
 */
import { zodToJsonSchema } from 'zod-to-json-schema';
import type { ToolDescriptor } from './protocol.js';

/**
 * Lazy-load the host's tool registry. Kept as a runtime dynamic
 * import so the daemon's `pair` / `status` / `--help` commands don't
 * require `@swarmai/tools` to be present at all — esbuild can't
 * eliminate a static `import { toolRegistry } from '@swarmai/tools'`
 * even when only `pair` runs, because static ESM imports are hoisted.
 */
async function getRegistry(): Promise<{ list(): { name: string; toolset: string; description: string; policy?: string; schema: unknown; schemaOverride?: Record<string, unknown> }[] }> {
  const mod = await import('@swarmai/tools');
  return (mod as unknown as { toolRegistry: { list(): never[] } }).toolRegistry as never;
}

export async function snapshotCatalog(): Promise<ToolDescriptor[]> {
  const toolRegistry = await getRegistry();
  const defs = toolRegistry.list();
  const out: ToolDescriptor[] = [];
  for (const def of defs) {
    let schema: Record<string, unknown>;
    if (def.schemaOverride) {
      schema = def.schemaOverride;
    } else {
      try {
        schema = zodToJsonSchema(def.schema as never, {
          target: 'openAi',
        }) as Record<string, unknown>;
      } catch (err) {
        // A pathological zod schema shouldn't blow up the whole catalog.
        // Surface an empty-object schema; the remote side will reject
        // any invocation with "args don't match", which is the safest
        // failure mode.
        console.warn(
          `[device-agent] failed to convert schema for tool ${def.name}: ${
            err instanceof Error ? err.message : err
          }`,
        );
        schema = { type: 'object', properties: {}, additionalProperties: true };
      }
    }
    out.push({
      name: def.name,
      toolset: def.toolset,
      description: def.description,
      policy: (def.policy ?? 'open') as ToolDescriptor['policy'],
      schema,
    });
  }
  // Stable name-sort so the gateway can dedup announces cheaply.
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}
