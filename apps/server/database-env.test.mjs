import { test } from 'node:test';
import assert from 'node:assert/strict';

import { pinLoopback, resolveDatabaseEnv } from './database-env.mjs';

test('prefers DATABASE_URL and defaults the other two to it, in single-user mode', () => {
  const url = 'mysql://u1_tm:p%40ss@127.0.0.1:3306/u1_tm';
  const { values } = resolveDatabaseEnv({ DATABASE_URL: url, DB_HOST: 'ignored' });
  assert.equal(values.DATABASE_URL, url);
  assert.equal(values.DATABASE_MIGRATION_URL, url);
  assert.equal(values.WORKER_DATABASE_URL, url);
  assert.equal(values.DATABASE_SINGLE_USER, 'true');
});

test('assembles DATABASE_URL from DB_* parts, percent-encoding the password', () => {
  const { values } = resolveDatabaseEnv({
    DB_HOST: '127.0.0.1',
    DB_PORT: '3306',
    DB_NAME: 'u1_tm',
    DB_USER: 'u1_tm',
    DB_PASSWORD: 'p@ss:w/rd',
  });
  assert.equal(values.DATABASE_URL, 'mysql://u1_tm:p%40ss%3Aw%2Frd@127.0.0.1:3306/u1_tm');
  assert.equal(new URL(values.DATABASE_URL).password, 'p%40ss%3Aw%2Frd');
});

test('rewrites a localhost host to 127.0.0.1 and leaves other hosts alone', () => {
  const { values } = resolveDatabaseEnv({ DATABASE_URL: 'mysql://a:b@localhost:3306/db' });
  assert.equal(values.DATABASE_URL, 'mysql://a:b@127.0.0.1:3306/db');
  assert.equal(values.WORKER_DATABASE_URL, 'mysql://a:b@127.0.0.1:3306/db');
  assert.equal(pinLoopback('mysql://a:b@db.example:3306/db'), 'mysql://a:b@db.example:3306/db');
});

test('three distinct users keep the three-user mode', () => {
  const { values } = resolveDatabaseEnv({
    DATABASE_URL: 'mysql://app:x@127.0.0.1:3306/db',
    DATABASE_MIGRATION_URL: 'mysql://mig:x@127.0.0.1:3306/db',
    WORKER_DATABASE_URL: 'mysql://wrk:x@127.0.0.1:3306/db',
  });
  assert.equal(values.DATABASE_SINGLE_USER, undefined);
});

test('reports, and sets nothing, when no database is configured', () => {
  const { values, notes } = resolveDatabaseEnv({});
  assert.deepEqual(values, {});
  assert.match(notes[0], /neither DATABASE_URL nor DB_HOST/);
});
