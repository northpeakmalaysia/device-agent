/**
 * Local ambient types for `@swarmai/shared`.
 *
 * Surfaces only the `z` zod re-export the device-agent consumes. The
 * actual runtime module is supplied at install time (via @swarmai/tools'
 * peer chain); these stubs only satisfy the standalone TypeScript build.
 */

declare module '@swarmai/shared' {
  export { z } from 'zod';
}
