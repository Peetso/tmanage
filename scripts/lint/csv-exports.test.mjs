import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkSource } from './csv-exports.mjs';

const noFiles = () => null;

test('a producer that writes through the domain toCsv passes', () => {
  const text = `import { toCsv } from '@tmanage/domain';
reply.header('content-type', 'text/csv; charset=utf-8');
const body = toCsv(rows, ['a', 'b']);`;
  assert.deepEqual(checkSource('/x/ok.ts', text, noFiles), []);
});

test("a producer that joins cells with join(',') fails", () => {
  const text = `reply.header('content-type', 'text/csv; charset=utf-8');
const body = rows.map((row) => row.join(',')).join('\\n');`;
  const rules = checkSource('/x/bad.ts', text, noFiles).map((error) => error.rule);
  assert.deepEqual(rules, ['hand-joined', 'no-domain']);
});
