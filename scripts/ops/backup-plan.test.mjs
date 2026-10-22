import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  buildManifest,
  checkTargetName,
  compareMigrations,
  migrationVersions,
  parseArgs,
  parseDatabaseUrl,
  selectForPruning,
  stampOf,
  stripDefiner,
  validateManifest,
} from './backup-plan.mjs';

test('parseArgs reads both value forms and booleans, rejects unknown flags', () => {
  const spec = { from: 'string', 'i-know': 'boolean' };
  assert.deepEqual(parseArgs(['--from', 'a', '--i-know'], spec), { from: 'a', 'i-know': true });
  assert.deepEqual(parseArgs(['--from=b'], spec), { from: 'b' });
  assert.throws(() => parseArgs(['--nope'], spec), /Unknown option/);
  assert.throws(() => parseArgs(['--from'], spec), /needs a value/);
});

test('parseDatabaseUrl decodes credentials and refuses other schemes', () => {
  assert.deepEqual(parseDatabaseUrl('mysql://u%40x:p%3Aw@db:3307/tm_restore'), {
    host: 'db',
    port: 3307,
    user: 'u@x',
    password: 'p:w',
    database: 'tm_restore',
  });
  assert.throws(() => parseDatabaseUrl('postgres://u@h/db'), /mysql/);
  assert.throws(() => parseDatabaseUrl('mysql://u@h/'), /no database/);
});

test('selectForPruning keeps the newest N stamps and ignores other entries', () => {
  const entries = ['20261001T000000Z', 'notes.txt', '20261003T000000Z', '20261002T000000Z'];
  assert.deepEqual(selectForPruning(entries, 2), ['20261001T000000Z']);
  assert.equal(stampOf(new Date('2026-10-22T03:15:09.123Z')), '20261022T031509Z');
});

test('manifest round-trips through validateManifest', () => {
  const versions = migrationVersions(['0002_b.sql', '0001_a.sql', 'README.md']);
  const m = buildManifest({
    stamp: '20261022T031509Z',
    createdAt: '2026-10-22T03:15:09.123Z',
    gitSha: 'abc',
    database: 'tmanage',
    migrations: versions,
    files: { db: { name: 'db.sql.gz', bytes: 10 } },
  });
  assert.deepEqual(m.migrations, { count: 2, latest: 2, versions: [1, 2] });
  assert.deepEqual(validateManifest(JSON.parse(JSON.stringify(m))), m);
  assert.throws(() => validateManifest({ ...m, format: 9 }), /format/);
});

test('checkTargetName refuses production-looking names unless --i-know', () => {
  assert.equal(checkTargetName('tmanage_restore').ok, true);
  assert.equal(checkTargetName('tm_test').ok, true);
  assert.equal(checkTargetName('u123_tmanage').ok, false);
  assert.equal(checkTargetName('u123_tmanage', true).ok, true);
});

test('compareMigrations reports missing and extra versions', () => {
  assert.deepEqual(compareMigrations([1, 2, 3], [1, 3, 4]), {
    ok: false,
    missing: [2],
    extra: [4],
  });
  assert.equal(compareMigrations([1], [1]).ok, true);
});

test('stripDefiner removes both definer forms', () => {
  const line =
    '/*!50017 DEFINER=`u`@`localhost`*/ /*!50003 TRIGGER t */ CREATE DEFINER=`u`@`%` PROC';
  assert.equal(stripDefiner(line), '/*!50003 TRIGGER t */ CREATE PROC');
});
