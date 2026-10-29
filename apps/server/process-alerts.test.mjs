import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { reportCrash } from './process-alerts.mjs';

test('a crash mails once per window across restarts, then reports the held-back count', async () => {
  const calls = [];
  const alerts = {
    notify: (kind, facts) => (calls.push({ kind, facts }), Promise.resolve('sent')),
  };
  const stateFile = join(mkdtempSync(join(tmpdir(), 'crash-')), 'state.json');
  const options = { stateFile, fs: { readFileSync, writeFileSync }, windowMs: 1_000 };
  const error = new TypeError('mysql://user:secret@db');
  assert.equal(
    await reportCrash(alerts, error, 'uncaughtException', { ...options, now: 5_000 }),
    'sent',
  );
  assert.equal(
    await reportCrash(alerts, error, 'uncaughtException', { ...options, now: 5_500 }),
    'throttled',
  );
  assert.equal(
    await reportCrash(alerts, error, 'unhandledRejection', { ...options, now: 6_000 }),
    'sent',
  );
  assert.equal(calls[0].kind, 'process_crash:uncaughtException:TypeError');
  assert.match(calls[1].facts.detail, /1 earlier crash/);
  assert.doesNotMatch(JSON.stringify(calls), /secret/);
});
