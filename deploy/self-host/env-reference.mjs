// 54-19. Write docs/ops/self-host/ENV-REFERENCE.md from the config schema.
//
//   node deploy/self-host/env-reference.mjs           write the file
//   node deploy/self-host/env-reference.mjs --check   exit 1 if the file is stale
//
// Needs @tmanage/config built (`pnpm --filter @tmanage/config build`); the rendering lives in
// packages/config/src/env-reference.ts so the unit test and this script share one code path.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const { renderEnvReference } = await import(
  new URL('../../packages/config/dist/index.js', import.meta.url).href
);

const source = readFileSync(resolve(REPO, 'packages/config/src/env.ts'), 'utf8');
const target = resolve(REPO, 'docs/ops/self-host/ENV-REFERENCE.md');
const next = renderEnvReference(source);

if (process.argv.includes('--check')) {
  const current = readFileSync(target, 'utf8');
  if (current !== next) {
    process.stderr.write(
      'ENV-REFERENCE.md is stale: run node deploy/self-host/env-reference.mjs\n',
    );
    process.exit(1);
  }
  process.stdout.write('ENV-REFERENCE.md is current\n');
} else {
  writeFileSync(target, next);
  process.stdout.write(`wrote ${target}\n`);
}
