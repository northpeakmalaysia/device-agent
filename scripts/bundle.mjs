#!/usr/bin/env node
/**
 * @swarmai/device-agent — closed-source bundler.
 *
 * Same pattern as @swarmai/desktop/scripts/bundle.mjs and
 * @swarmai/acp/scripts/bundle.mjs. See those files' headers for the
 * architecture rationale.
 *
 * Plugin-specific notes:
 *   - This is a DAEMON binary (not a plugin loaded into a host), so we
 *     bundle main.ts into dist/main.js — the bin shim
 *     `bin/device-agent.js` loads it via `import()`.
 *   - Runtime deps `ws`, `yaml`, `zod-to-json-schema` are KEPT external
 *     because they're shipped in node_modules at install time (see
 *     package.json#dependencies). Bundling them would balloon dist size
 *     and break native bindings (`bufferutil`/`utf-8-validate` in `ws`).
 *   - `@swarmai/*` packages are also external — they're real runtime
 *     deps that npm pulls into node_modules. We side-effect-import
 *     `@swarmai/desktop` + `@swarmai/cli-tools` from main.ts so their
 *     tools register into the in-process registry.
 */
import { build } from 'esbuild';
import { rmSync, mkdirSync, existsSync, statSync, chmodSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { execSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = resolve(__dirname, '..');
const OUT = join(PLUGIN_ROOT, 'dist');

console.log(`[bundle] @swarmai/device-agent`);
console.log(`[bundle] root: ${PLUGIN_ROOT}`);
console.log(`[bundle] out:  ${OUT}`);

if (existsSync(OUT)) rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

const EXTERNAL = [
  '@swarmai/*',
  'ws',
  'yaml',
  'zod-to-json-schema',
  'zod',
  // `ws` optional native peers — esbuild would try to resolve them.
  'bufferutil',
  'utf-8-validate',
];

const t0 = Date.now();
await build({
  entryPoints: [join(PLUGIN_ROOT, 'src/main.ts')],
  bundle: true,
  minify: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  outfile: join(OUT, 'main.js'),
  external: EXTERNAL,
  absWorkingDir: PLUGIN_ROOT,
  legalComments: 'none',
  treeShaking: true,
  // No sourcemap -- this is the closed-source artefact. A sourcemap fully
  // reverses minification (webcrack/standard consumers can reconstruct the
  // original TypeScript), defeating the minify pass's IP-protection purpose.
  sourcemap: false,
  // ESM in Node needs `import.meta.url` resolution; esbuild handles it
  // natively when format=esm + platform=node.
});
console.log(`[bundle] esbuild done in ${Date.now() - t0}ms`);

// Emit .d.ts for the few public types we expose (minimal — the daemon
// is consumed via its CLI, not as a library, but tsc also serves as a
// type-check gate so we keep it on by default).
try {
  console.log(`[bundle] tsc --emitDeclarationOnly`);
  execSync(
    'npx tsc --emitDeclarationOnly --declarationMap false --sourceMap false',
    {
      cwd: PLUGIN_ROOT,
      stdio: 'inherit',
    },
  );
} catch (err) {
  // Don't fail the bundle if tsc emit hits a noise warning — the bundle
  // is the primary artefact. Operators wanting strict types can run
  // `npm run typecheck` separately.
  console.warn(
    `[bundle] tsc --emitDeclarationOnly exited non-zero (continuing): ${
      err instanceof Error ? err.message : err
    }`,
  );
}

// Make the bin shim executable on POSIX. fs.chmodSync is a no-op on
// Windows for the +x bit, which is fine — npm rewrites the bin entry to
// a `.cmd` wrapper on install regardless.
try {
  chmodSync(join(PLUGIN_ROOT, 'bin/device-agent.js'), 0o755);
} catch (err) {
  console.warn(
    `[bundle] chmod +x bin/device-agent.js failed (continuing): ${
      err instanceof Error ? err.message : err
    }`,
  );
}

const jsSize = statSync(join(OUT, 'main.js')).size;
console.log(`[bundle] dist/main.js = ${(jsSize / 1024).toFixed(1)} KiB`);
console.log(`[bundle] done`);
