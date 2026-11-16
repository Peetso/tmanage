// Run: node --test deploy/hostinger/vendor-trees.test.mjs
//
// A vendored package ships its dist/ plus the run-time trees in VENDOR_EXTRA_TREES. The api's
// sealed-record PDF (record-pdf.ts) embeds the Arabic face from `assets/fonts`, resolved three
// levels up from dist/modules/approvals/; a bundle without that folder still boots, but every
// Arabic character in a sealed PDF prints as "?". This pins the folder into the bundle and checks
// that the path the code resolves lands on it.
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { VENDOR_EXTRA_TREES } from './build.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const API = join(REPO, 'apps/api');
const RECORD_PDF = join(API, 'src/modules/approvals/record-pdf.ts');

test('every extra tree exists in its package', () => {
  for (const [pkg, trees] of Object.entries(VENDOR_EXTRA_TREES)) {
    const base = pkg === 'api' ? API : join(REPO, 'packages', pkg);
    for (const tree of trees) assert.ok(existsSync(join(base, tree)), `${pkg}/${tree} is missing`);
  }
});

test('the api ships the fonts record-pdf.ts embeds', () => {
  assert.ok(VENDOR_EXTRA_TREES.api.includes('assets/fonts'));
  const source = readFileSync(RECORD_PDF, 'utf8');
  const name = source.match(/const name = '([^']+\.ttf)'/)?.[1];
  assert.ok(name, 'record-pdf.ts names its font file');
  assert.ok(existsSync(join(API, 'assets/fonts', name)), `${name} is in apps/api/assets/fonts`);

  // dist mirrors src (rootDir ./src), so the compiled file sits at dist/modules/approvals/ and
  // its `here`-relative font path must land on <package>/assets/fonts in the bundle.
  const relPath = source.match(/resolve\(here, '([^']+)', name\)/)?.[1];
  assert.ok(relPath, 'record-pdf.ts resolves the font relative to its own file');
  const pkgRoot = '/vendor/@tmanage/api';
  const resolved = resolve(join(pkgRoot, 'dist/modules/approvals'), relPath);
  assert.equal(relative(pkgRoot, resolved).replaceAll('\\', '/'), 'assets/fonts');
});
