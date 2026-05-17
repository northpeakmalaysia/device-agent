#!/usr/bin/env node
/**
 * Bin shim for `swarmai-device-agent`. Loads the bundled ESM entry from
 * dist/main.js. We use a thin loader rather than putting the entry
 * directly in `bin/` so that:
 *   1. Source-map resolution stays predictable (--enable-source-maps
 *      picks up dist/main.js.map next to the bundle).
 *   2. The shim survives `npm pack`/`npm install -g` on every supported
 *      platform — Windows generates `.cmd` wrappers that exec `node` on
 *      this file, POSIX uses the shebang directly.
 */
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const entry = pathToFileURL(join(__dirname, '..', 'dist', 'main.js')).href;
await import(entry);
