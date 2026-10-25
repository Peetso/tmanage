import assert from 'node:assert/strict';
import test from 'node:test';

import { beat, reportJobOutcome } from './job-alerts.mjs';

function recorder() {
  const calls = [];
  return {
    calls,
    notify: (kind, facts) => {
      calls.push({ kind, facts });
      return Promise.resolve('sent');
    },
  };
}

test('a thrown batch is one job_failed alert carrying only the error class name', async () => {
  const alerts = recorder();
  const raised = await reportJobOutcome(alerts, 'outbox', {
    error: new TypeError('connect ECONNREFUSED user:secret@db'),
  });
  assert.deepEqual(raised, ['job_failed:outbox']);
  assert.deepEqual(alerts.calls, [
    { kind: 'job_failed:outbox', facts: { errorName: 'TypeError' } },
  ]);
});

test('failed and parked events each raise their own kind; a clean batch raises none', async () => {
  const alerts = recorder();
  assert.deepEqual(
    await reportJobOutcome(alerts, 'notices', { report: { failed: 2, parked: [{}, {}, {}] } }),
    ['job_failed:notices', 'job_parked:notices'],
  );
  assert.match(alerts.calls[1].facts.detail, /^3 event/);
  assert.deepEqual(
    await reportJobOutcome(alerts, 'outbox', { report: { failed: 0, parked: [] } }),
    [],
  );
});

test('no notifier means no alert and no throw; a failing notifier never throws either', async () => {
  assert.deepEqual(await reportJobOutcome(undefined, 'outbox', { error: new Error('x') }), []);
  const broken = { notify: () => Promise.reject(new Error('smtp')) };
  await reportJobOutcome(broken, 'outbox', { error: new Error('x') });
});

test('beat writes the heartbeat when a path is set and swallows a write failure', async () => {
  const writes = [];
  await beat((path, at) => {
    writes.push([path, at instanceof Date]);
    return Promise.resolve();
  }, '/tmp/hb.json');
  await beat(() => Promise.reject(new Error('EACCES')), '/tmp/hb.json');
  await beat(() => assert.fail('must not write without a path'), undefined);
  assert.deepEqual(writes, [['/tmp/hb.json', true]]);
});
