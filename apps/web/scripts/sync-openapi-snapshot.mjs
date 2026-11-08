#!/usr/bin/env node
/**
 * 54-04 — snapshot the product API contract for the public developer portal (`/developers`).
 *
 * Reads the COMMITTED `docs/planning/contracts/openapi.yaml` (`git show HEAD:…`, so an uncommitted
 * edit in the working tree never reaches the site), parses it with js-yaml (already in the
 * workspace through the root `pnpm.overrides`), and writes the parsed document as JSON to
 * `src/content/developers/openapi-snapshot.json`. The page turns that JSON into the reference at
 * build time (`buildApiReference`). This script only ever reads the contract; it never writes it.
 *
 * Run from `apps/web`: `node scripts/sync-openapi-snapshot.mjs`.
 */
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..', '..');
const require = createRequire(join(repoRoot, 'node_modules', '.pnpm', 'node_modules', 'noop.js'));
const yaml = require('js-yaml');

const source = execFileSync('git', ['show', 'HEAD:docs/planning/contracts/openapi.yaml'], {
  cwd: repoRoot,
  encoding: 'utf8',
  maxBuffer: 16 * 1024 * 1024,
});
const spec = yaml.load(source, { schema: yaml.JSON_SCHEMA });
const out = join(here, '..', 'src', 'content', 'developers', 'openapi-snapshot.json');
writeFileSync(out, `${JSON.stringify(spec, null, 2)}\n`, 'utf8');
console.log(`wrote ${out}`);
