/**
 * Local ambient types for `@swarmai/plugin-sdk`.
 *
 * Surfaces only the symbols `@swarmai/device-agent` consumes. The actual
 * runtime module is supplied by `@swarmai/tools` (which re-exports the
 * shape) at install time — these stubs exist purely so the standalone
 * TypeScript build doesn't fail to resolve missing-package imports in
 * environments where the monorepo isn't checked out next to this plugin.
 *
 * Kept in lock-step with `packages/plugin-sdk/src/tool-contract.ts`
 * in the SwarmAI monorepo.
 */

declare module '@swarmai/plugin-sdk' {
  export interface ToolContext {
    sessionId: string;
    agentId: string;
    isMain: boolean;
    currentTier?: 'heavy' | 'average' | 'simple';
  }

  export type ToolPolicy = 'open' | 'pair-gated' | 'master';

  export interface ToolDef<S = unknown, O = unknown> {
    name: string;
    toolset: string;
    description: string;
    schema: S;
    handler: (input: unknown, ctx: ToolContext) => Promise<O>;
    emoji?: string;
    policy?: ToolPolicy;
    requiresApproval?: boolean;
    maxResultSize?: number;
    minTier?: 'heavy' | 'average' | 'simple';
    schemaOverride?: Record<string, unknown>;
  }
}
