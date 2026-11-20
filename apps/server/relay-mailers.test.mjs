import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * QA-FIX-O H1 (DC-7's class, applied to the outbox relay). The live app runs the worker's relay
 * inside this process (`startInProcessWorker`, `WORKER_INPROCESS=1`) with its own call to
 * `createWorkerOutboxHandlers`. That call left out `collaborationMailer`, so on live every
 * collaboration e-mail (approval requests and decisions, mentions, meeting invites, client
 * actions, request messages) was planned and written to the inbox but never mailed, while the
 * standalone worker (`apps/worker/src/main.ts`) mailed them.
 *
 * This fitness check keeps the two compositions equal: every dependency the standalone worker
 * hands the relay, the in-process relay hands it too.
 */

const HERE = dirname(fileURLToPath(import.meta.url));

/** The top-level keys of the object literal passed to `createWorkerOutboxHandlers({ … })`. */
export function relayDependencyKeys(source) {
  const call = source.indexOf('createWorkerOutboxHandlers({');
  assert.notEqual(call, -1, 'the composition calls createWorkerOutboxHandlers({ … })');
  const open = source.indexOf('{', call);
  let depth = 0;
  let close = -1;
  for (let index = open; index < source.length; index += 1) {
    const char = source[index];
    if (char === '{' || char === '(' || char === '[') depth += 1;
    if (char === '}' || char === ')' || char === ']') depth -= 1;
    if (depth === 0) {
      close = index;
      break;
    }
  }
  const body = source.slice(open + 1, close).replace(/\/\/[^\n]*/gu, '');
  const keys = new Set();
  let level = 0;
  let token = '';
  for (const char of body) {
    if (char === '{' || char === '(' || char === '[') level += 1;
    if (char === '}' || char === ')' || char === ']') level -= 1;
    if (level !== 0) continue;
    if (char === ':') {
      const name = /([A-Za-z_$][\w$]*)\s*$/u.exec(token)?.[1];
      if (name) keys.add(name);
      token = '';
    } else if (char === ',') {
      const shorthand = /^\s*([A-Za-z_$][\w$]*)\s*$/u.exec(token)?.[1];
      if (shorthand) keys.add(shorthand);
      token = '';
    } else {
      token += char;
    }
  }
  const shorthand = /^\s*([A-Za-z_$][\w$]*)\s*$/u.exec(token)?.[1];
  if (shorthand) keys.add(shorthand);
  return [...keys].sort();
}

test('the in-process relay is handed every dependency the standalone worker is handed', () => {
  const worker = readFileSync(join(HERE, '../worker/src/main.ts'), 'utf8');
  const live = readFileSync(join(HERE, 'server.mjs'), 'utf8');
  const standalone = relayDependencyKeys(worker);
  assert.ok(standalone.includes('collaborationMailer'), 'the parser reads the worker keys');
  assert.deepEqual(relayDependencyKeys(live), standalone);
});
