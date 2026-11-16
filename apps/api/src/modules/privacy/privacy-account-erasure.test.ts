import { describe, expect, it } from 'vitest';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import { AccountErasure, erasableTables, erasedEmail } from './privacy-erasure.repository.js';

/**
 * 56-18 — the erasure after an executed account deletion, over a recording fake: every statement
 * Drizzle emits is kept with its bound values, selects answer from a tiny script, writes report
 * one row. No database; what is proven is which statements run and what they are scoped to.
 */

const ORG = '00000000-0000-4000-8000-0000000000b1';
const USER = '00000000-0000-4000-8000-0000000000c1';
const context = { organizationId: ORG, correlationId: 'c' } as unknown as TenantContext;

interface Statement {
  readonly path: 'tenant' | 'bootstrap' | 'identity';
  readonly sql: string;
  readonly params: readonly unknown[];
}

function fakeDatabase(answers: { member?: boolean; staff?: boolean; email?: string }) {
  const statements: Statement[] = [];
  const runner = (path: Statement['path']) => ({
    query: (sql: string, params: readonly unknown[]) => {
      statements.push({ path, sql, params });
      if (!sql.startsWith('select')) return Promise.resolve({ affectedRows: 1 });
      if (sql.includes('from `memberships`')) return Promise.resolve(answers.member ? [['m']] : []);
      if (sql.includes('from `client_memberships`')) return Promise.resolve([]);
      if (sql.includes('from `platform_admins`'))
        return Promise.resolve(answers.staff ? [['p']] : []);
      if (sql.includes('from `users`')) return Promise.resolve([[answers.email ?? 'ana@x.test']]);
      return Promise.resolve([]);
    },
  });
  const database = {
    transaction: (_c: unknown, fn: (r: unknown) => unknown) => fn(runner('tenant')),
    bootstrapRead: (_o: unknown, fn: (r: unknown) => unknown) => fn(runner('bootstrap')),
    identityTransaction: (_o: unknown, fn: (r: unknown) => unknown) => fn(runner('identity')),
  } as unknown as TenantDatabase;
  return { database, statements };
}

const writes = (statements: readonly Statement[]) =>
  statements.filter((s) => !s.sql.startsWith('select'));

describe('56-18 account erasure', () => {
  it('nulls the person’s invoice-event IP and agent in the requesting company only', async () => {
    const { database, statements } = fakeDatabase({ member: true });
    const outcome = await new AccountErasure(database).run(context, USER);
    expect(outcome.global).toBe('kept_other_memberships');
    const [redact] = writes(statements);
    expect(redact?.sql).toMatch(/^update `client_invoice_events` set `ip` = \?, `ua` = \?/u);
    // Scoped by workspace and subject; fails if either predicate is dropped.
    expect(redact?.sql).toContain('`client_invoice_events`.`organization_id` = ?');
    expect(redact?.sql).toContain('`client_invoice_events`.`actor_id` = ?');
    expect(redact?.params.slice(-2)).toEqual([ORG, USER]);
    expect(statements.some((s) => s.path === 'identity')).toBe(false);
  });

  it('erases the global account once the person belongs nowhere', async () => {
    const { database, statements } = fakeDatabase({});
    const at = new Date('2026-11-16T10:00:00.000Z');
    expect((await new AccountErasure(database, () => at).run(context, USER)).global).toBe('erased');
    const identity = writes(statements).filter((s) => s.path === 'identity');
    const deleted = identity.filter((s) => s.sql.startsWith('delete')).map((s) => s.sql);
    for (const table of [
      '`sessions`',
      '`user_passwords`',
      '`user_mfa_factors`',
      '`user_passkeys`',
    ]) {
      expect(deleted.some((sql) => sql.split(' ')[2] === table)).toBe(true);
    }
    const account = identity.find((s) => s.sql.startsWith('update `users`'));
    expect(account?.params).toContain(erasedEmail(USER));
    expect(account?.params).toContain('Former member');
    expect(account?.params.at(-1)).toBe(USER);
    const signIns = identity.find((s) => s.sql.startsWith('update `authentication_events`'));
    expect(signIns?.params).toEqual([null, null, null, USER]);
  });

  it('keeps a platform staff account and an already erased one untouched', async () => {
    for (const [answers, global] of [
      [{ staff: true }, 'kept_platform_staff'],
      [{ email: erasedEmail(USER) }, 'already_erased'],
    ] as const) {
      const { database, statements } = fakeDatabase(answers);
      expect((await new AccountErasure(database).run(context, USER)).global).toBe(global);
      expect(writes(statements).filter((s) => s.path === 'identity')).toEqual([]);
    }
  });

  it('empties the inbound e-mail tables with the company (54-12 rows)', () => {
    expect(erasableTables()).toEqual(
      expect.arrayContaining(['inbound_emails', 'inbound_email_attachments']),
    );
  });
});
