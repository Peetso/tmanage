import { test } from 'node:test';
import assert from 'node:assert/strict';

import { WEB_RESTART_BASE_MS, WEB_RESTART_CAP_MS, webRestartDelayMs } from './web-restart.mjs';

test('the restart delay grows exponentially with each consecutive crash and is capped', () => {
  assert.equal(webRestartDelayMs(0), WEB_RESTART_BASE_MS);
  assert.equal(webRestartDelayMs(1), WEB_RESTART_BASE_MS * 2);
  assert.equal(webRestartDelayMs(2), WEB_RESTART_BASE_MS * 4);
  assert.equal(webRestartDelayMs(3), WEB_RESTART_BASE_MS * 8);
  // The doubling never exceeds the cap, however many times the child has crashed.
  assert.equal(webRestartDelayMs(20), WEB_RESTART_CAP_MS);
  assert.equal(webRestartDelayMs(1000), WEB_RESTART_CAP_MS);
});

test('a non-finite or negative attempt is treated as the first (0th) restart', () => {
  assert.equal(webRestartDelayMs(-5), WEB_RESTART_BASE_MS);
  assert.equal(webRestartDelayMs(Number.NaN), WEB_RESTART_BASE_MS);
  assert.equal(webRestartDelayMs(Number.POSITIVE_INFINITY), WEB_RESTART_BASE_MS);
});

test('custom base and cap bounds are honoured', () => {
  assert.equal(webRestartDelayMs(0, { baseMs: 100, capMs: 1000 }), 100);
  assert.equal(webRestartDelayMs(2, { baseMs: 100, capMs: 1000 }), 400);
  assert.equal(webRestartDelayMs(10, { baseMs: 100, capMs: 1000 }), 1000);
});
