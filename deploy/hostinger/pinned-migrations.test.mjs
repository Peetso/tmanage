// Pinned migration bytes (NEWDOMAIN, 2026-11-17). The site moved from tmanage.peetrix.com to
// tmanageapp.com. Migration 0208 names the old host in a comment, and Hostinger's domain change
// rewrote that address inside the server's copy: the migrator then refused to start with
// "Checksum mismatch" until the owner restored the file. An applied migration is never edited, so
// its sha256 is pinned here, the bundle build refuses a changed copy, and the deploy smoke fails
// by name when the start log reports a checksum mismatch.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { PINNED_MIGRATIONS, pinnedMigrationProblems, startLogProblems } from './build.mjs';

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '../../apps/api/migrations');
const PINNED_0208 = 'd6cc88c7c8d1bd4489e50b2398adc1ba80a0dd1eec5fa482da784429208826dd';

test('0208_oauth_core.sql keeps its applied bytes, old host comment included', () => {
  const bytes = readFileSync(join(MIGRATIONS, '0208_oauth_core.sql'));
  assert.equal(createHash('sha256').update(bytes).digest('hex'), PINNED_0208);
  assert.equal(PINNED_MIGRATIONS['0208_oauth_core.sql'], PINNED_0208);
  assert.deepEqual(pinnedMigrationProblems(MIGRATIONS), []);
});

test('a rewritten or missing pinned migration is refused by name', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tm-pinned-'));
  try {
    const original = readFileSync(join(MIGRATIONS, '0208_oauth_core.sql'), 'utf8');
    assert.match(pinnedMigrationProblems(dir)[0] ?? '', /0208_oauth_core\.sql is missing/);
    // What Hostinger's domain change did: the old address replaced by the new one.
    writeFileSync(
      join(dir, '0208_oauth_core.sql'),
      original.replaceAll('tmanage.peetrix.com', 'tmanageapp.com'),
    );
    assert.match(pinnedMigrationProblems(dir)[0] ?? '', /0208_oauth_core\.sql has sha256 /);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a "Checksum mismatch" in the start log is a deploy failure', () => {
  assert.deepEqual(
    startLogProblems('migrations applied\nready on :3000 (web via /tmp/web.sock,'),
    [],
  );
  const problems = startLogProblems(
    'boot\nError: Checksum mismatch for 0208_oauth_core.sql: the database recorded abc but\n',
  );
  assert.equal(problems.length, 1);
  assert.match(problems[0] ?? '', /Checksum mismatch for 0208_oauth_core\.sql/);
});
