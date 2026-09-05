import { describe, expect, it } from 'vitest';
import { unwrapQueryError } from './query-error.js';

describe('unwrapQueryError', () => {
  it('returns the driver error without the statement the driver inlined the values into', () => {
    const cause = Object.assign(new Error("Duplicate entry 'x' for key 'uq_example'"), {
      code: 'ER_DUP_ENTRY',
      errno: 1062,
      sqlState: '23000',
      sql: "insert into t (name) values ('a value that must not reach a log')",
    });
    const wrapper = Object.assign(new Error('Failed query: insert into t (name) values (?)'), {
      query: 'insert into t (name) values (?)',
      params: ['a value that must not reach a log'],
      cause,
    });

    const unwrapped = unwrapQueryError(wrapper) as Record<string, unknown>;

    expect(unwrapped).toBe(cause);
    expect(unwrapped['code']).toBe('ER_DUP_ENTRY');
    expect(unwrapped['errno']).toBe(1062);
    // Reversal: return `cause` untouched and the statement, values inlined, is here.
    expect('sql' in unwrapped).toBe(false);
  });

  it('hands back anything that is not the wrapper unchanged', () => {
    const plain = Object.assign(new Error('plain'), { sql: 'kept: not the wrapper, not ours' });
    expect(unwrapQueryError(plain)).toBe(plain);
    expect((plain as { sql?: string }).sql).toBeDefined();
  });
});
