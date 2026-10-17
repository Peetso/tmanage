import { describe, expect, it } from 'vitest';
import { uuidv7 } from '@tmanage/domain';
import type { TenantQueryRunner } from '../../common/database/tenant-context.js';
import { FirstOwnerEmailTakenError, FirstOwnerRepository } from './first-owner.repository.js';

interface Captured {
  readonly sql: string;
  readonly params: readonly unknown[];
}

function fakeRunner(respond: (sql: string, params: readonly unknown[]) => unknown): {
  runner: Pick<TenantQueryRunner, 'query'>;
  captured: Captured[];
} {
  const captured: Captured[] = [];
  const query = (async (sql: string, params: readonly unknown[] = []) => {
    captured.push({ sql, params });
    return respond(sql, params);
  }) as unknown as TenantQueryRunner['query'];
  return { runner: { query }, captured };
}

const repository = new FirstOwnerRepository();

describe('FirstOwnerRepository', () => {
  it('countExisting returns numeric counts from two separate statements', async () => {
    const { runner, captured } = fakeRunner((sql) =>
      // Positional rows, as the drizzle proxy asks for; one as a string, as mysql2 may return.
      sql.includes('`memberships`') ? [['2']] : [[3]],
    );

    const counts = await repository.countExisting(runner);

    expect(counts).toEqual({ organizations: 3, owners: 2 });
    expect(captured).toHaveLength(2);
    expect(captured[0]?.sql).toMatch(/count\(\*\).*from `organizations`/i);
    expect(captured[1]?.sql).toMatch(/from `memberships` where `memberships`.`role` = \?/i);
    expect(captured[1]?.params).toEqual(['owner']);
  });

  it('insertUser lower-cases the email and maps a duplicate email to FirstOwnerEmailTakenError', async () => {
    const user = {
      id: uuidv7(),
      email: '  Owner@Example.COM ',
      displayName: 'Owner',
      locale: 'en',
      timezone: 'UTC',
    };

    const ok = fakeRunner(() => ({ affectedRows: 1, insertId: 0 }));
    await repository.insertUser(ok.runner, user);
    expect(ok.captured[0]?.sql).toMatch(/insert into `users`/i);
    expect(ok.captured[0]?.sql).toMatch(/current_timestamp\(3\)/);
    expect(ok.captured[0]?.params).toContain('owner@example.com');

    const duplicate = Object.assign(
      new Error("Duplicate entry 'owner@example.com' for key 'uq_users_email'"),
      { code: 'ER_DUP_ENTRY', errno: 1062, sqlState: '23000' },
    );
    const taken = fakeRunner(() => {
      throw duplicate;
    });
    await expect(repository.insertUser(taken.runner, user)).rejects.toBeInstanceOf(
      FirstOwnerEmailTakenError,
    );
  });
});
