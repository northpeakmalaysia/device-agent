/**
 * Local ambient types for `@swarmai/tools`.
 *
 * Surfaces only the symbols the device-agent daemon consumes:
 *   - `toolRegistry` — the singleton ToolRegistry (we call .list() to
 *     snapshot the catalog after side-effect importing the tool plugins,
 *     and .dispatch() to invoke a tool from a remote tool/invoke RPC).
 *   - `register()` — re-export of the registry's register fn (we don't
 *     call it directly, but downstream plugin packages do at import time).
 *
 * Kept in lock-step with `packages/tools/src/registry.ts` in the monorepo.
 */

declare module '@swarmai/tools' {
  import type { ToolContext, ToolDef } from '@swarmai/plugin-sdk';

  export interface ToolRegistry {
    register(def: ToolDef): void;
    get(name: string): ToolDef | undefined;
    list(): ToolDef[];
    dispatch(name: string, rawArgs: string, ctx: ToolContext): Promise<string>;
  }

  export const toolRegistry: ToolRegistry;
  export function register(def: ToolDef): void;
}

declare module '@swarmai/desktop';
declare module '@swarmai/cli-tools';
