import { describe, expect, it } from 'vitest';
import type { ObjectStore } from '@tmanage/storage';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import { CompanyErasure } from './privacy-erasure.repository.js';

/**
 * Wave 14 / L4 — two shapes the first erasure could never finish, over a fake that behaves like
 * InnoDB: a foreign key is checked row by row, in id order, so a batch that reaches a parent before
 * its child is refused whole (errno 1451).
 *
 * 1. A self-referencing table (a thread reply → its root): the batch is refused, the row-by-row
 *    fallback takes the newest rows first and empties it.
 * 2. `oauth_grants`, referenced by the global token tables: the tokens issued under the company's
 *    grants go first, then the grants — and another company's tokens stay.
 */

const ORG = '00000000-0000-4000-8000-0000000000a1';
const context = { organizationId: ORG, correlationId: 'c' } as unknown as TenantContext;

interface Row {
  readonly id: string;
  readonly org: string;
  readonly parent: string | null;
}

const refused = () => Object.assign(new Error('errno 1451'), { errno: 1451 });

function fake(rows: Row[], tokens: { grant: string }[] = []) {
  const statements: string[] = [];
  const childOf = (id: string) => rows.some((row) => row.parent === id);
  const runner = {
    execute: (sql: string, params: readonly unknown[]) => {
      statements.push(sql);
      const tokenDelete = /^delete from `oauth_access_tokens` where `grant_id` in \(/u.exec(sql);
      if (tokenDelete) {
        const before = tokens.length;
        for (let i = tokens.length - 1; i >= 0; i -= 1) {
          if (params.includes(tokens[i]!.grant)) tokens.splice(i, 1);
        }
        return Promise.resolve({ affectedRows: before - tokens.length });
      }
      if (/^delete from `oauth_(codes|refresh_tokens)`/u.test(sql)) {
        return Promise.resolve({ affectedRows: 0 });
      }
      const one = /^delete from `(\w+)` where organization_id = \? and id = \?$/u.exec(sql);
      if (one) {
        const index = rows.findIndex((row) => row.org === params[0] && row.id === params[1]);
        if (index === -1) return Promise.resolve({ affectedRows: 0 });
        if (childOf(rows[index]!.id) || tokens.some((t) => t.grant === rows[index]!.id)) {
          return Promise.reject(refused());
        }
        rows.splice(index, 1);
        return Promise.resolve({ affectedRows: 1 });
      }
      const batch = /^delete from `(\w+)` where organization_id = \? limit (\d+)$/u.exec(sql);
      if (!batch) return Promise.reject(new Error(`unexpected statement: ${sql}`));
      // InnoDB: visit in id order, refuse the whole statement at the first referenced row.
      const mine = rows
        .filter((row) => row.org === params[0])
        .sort((a, b) => a.id.localeCompare(b.id))
        .slice(0, Number(batch[2]));
      for (const row of mine) {
        const stillChild = rows.some((other) => other.parent === row.id && !mine.includes(other));
        const visitedChild = mine.some(
          (other) => other.parent === row.id && mine.indexOf(other) > mine.indexOf(row),
        );
        if (stillChild || visitedChild || tokens.some((t) => t.grant === row.id)) {
          return Promise.reject(refused());
        }
      }
      for (const row of mine) rows.splice(rows.indexOf(row), 1);
      return Promise.resolve({ affectedRows: mine.length });
    },
    query: (sql: string, params: readonly unknown[]) => {
      statements.push(sql);
      if (sql.includes('file_versions') || sql.includes('upload_sessions')) {
        return Promise.resolve([]);
      }
      const after = params[1] as string | undefined;
      const desc = sql.includes('order by id desc');
      const selected = rows
        .filter((row) => row.org === params[0])
        .filter((row) =>
          after === undefined ? true : desc ? row.id < after : after === '' || row.id > after,
        )
        .sort((a, b) => (desc ? b.id.localeCompare(a.id) : a.id.localeCompare(b.id)))
        .map((row) => ({ id: row.id }));
      return Promise.resolve(selected);
    },
  };
  const database = {
    read: (_c: unknown, fn: (r: unknown) => unknown) => fn(runner),
    transaction: (_c: unknown, fn: (r: unknown) => unknown) => fn(runner),
  } as unknown as TenantDatabase;
  const store = { remove: () => Promise.resolve() } as unknown as Pick<ObjectStore, 'remove'>;
  return { database, store, statements };
}

describe('Company erasure — rows that point at their own table', () => {
  it('empties a threaded table the batch delete refuses, replies before roots', async () => {
    const rows: Row[] = [
      { id: 'm1', org: ORG, parent: null },
      { id: 'm2', org: ORG, parent: 'm1' },
      { id: 'm3', org: ORG, parent: null },
      { id: 'm4', org: ORG, parent: 'm3' },
      { id: 'm5', org: 'other', parent: null },
    ];
    const { database, store } = fake(rows);
    const outcome = await new CompanyErasure(database, store, ['messages'], {
      batchRows: 10,
      maxRowsPerRun: 100,
    }).run(context);
    expect(outcome).toEqual({ complete: true, rowsErased: 4, objectsRemoved: 0, blocked: {} });
    expect(rows).toEqual([{ id: 'm5', org: 'other', parent: null }]);
  });

  it('keeps to the budget inside the row-by-row pass', async () => {
    const rows: Row[] = [
      { id: 'm1', org: ORG, parent: null },
      { id: 'm2', org: ORG, parent: 'm1' },
      { id: 'm3', org: ORG, parent: 'm1' },
    ];
    const { database, store } = fake(rows);
    const outcome = await new CompanyErasure(database, store, ['messages'], {
      batchRows: 10,
      maxRowsPerRun: 2,
    }).run(context);
    expect(outcome.complete).toBe(false);
    expect(outcome.rowsErased).toBe(2);
    expect(rows.map((row) => row.id)).toEqual(['m1']);
  });
});

describe('Company erasure — the connector grants and their global tokens', () => {
  it("removes the company's tokens, then its grants, and leaves another company's tokens", async () => {
    const rows: Row[] = [
      { id: 'g1', org: ORG, parent: null },
      { id: 'g9', org: 'other', parent: null },
    ];
    const tokens = [{ grant: 'g1' }, { grant: 'g1' }, { grant: 'g9' }];
    const { database, store, statements } = fake(rows, tokens);
    const outcome = await new CompanyErasure(database, store, ['oauth_grants'], {
      batchRows: 10,
      maxRowsPerRun: 100,
    }).run(context);
    expect(outcome).toEqual({ complete: true, rowsErased: 3, objectsRemoved: 0, blocked: {} });
    expect(tokens).toEqual([{ grant: 'g9' }]);
    expect(rows.map((row) => row.id)).toEqual(['g9']);
    const tokenDelete = statements.findIndex((sql) => sql.includes('oauth_access_tokens'));
    const grantTable = '`oauth_grants`';
    const grantDelete = statements.findIndex(
      (sql) => sql.startsWith('delete') && sql.includes(grantTable),
    );
    expect(tokenDelete).toBeGreaterThanOrEqual(0);
    expect(tokenDelete).toBeLessThan(grantDelete);
  });
});
