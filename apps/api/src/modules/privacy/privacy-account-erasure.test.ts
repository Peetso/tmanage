import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { authenticationEvents } from '../../common/database/schema.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import {
  AccountErasure,
  erasableTables,
  erasedEmail,
  erasureGrants,
} from './privacy-erasure.repository.js';

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

  it('pseudonymises the account before the deletes and the redaction its log triggers allow', async () => {
    // 0378: the append-only triggers on the refresh-token ledger and the sign-in log let a row go
    // (or lose IP and agent) only once its account is erased, so the account row moves first.
    const { database, statements } = fakeDatabase({});
    await new AccountErasure(database).run(context, USER);
    // Each write as "<verb> <table>".
    const order = writes(statements)
      .filter((s) => s.path === 'identity')
      .map((s) => `${s.sql.split(' ')[0] ?? ''} ${/`([a-z0-9_]+)`/u.exec(s.sql)?.[1] ?? ''}`);
    expect(order.indexOf('update users')).toBe(0);
    expect(order.indexOf('delete session_refresh_tokens')).toBeGreaterThan(0);
    expect(order.indexOf('update authentication_events')).toBeGreaterThan(0);
  });

  it('leaves every sign-in log column but the redacted three immutable (0378 trigger)', () => {
    // The trigger that allows the redaction compares every other column; one added to the table
    // and not to the trigger would become writable by the erasure credential. The newest
    // migration that (re)creates the trigger is the one in force.
    const migrations = new URL('../../../migrations/', import.meta.url);
    const body = readdirSync(migrations)
      .filter((name) => name.endsWith('.sql'))
      .sort()
      .map((name) => readFileSync(new URL(name, migrations), 'utf8'))
      .flatMap((sql) => sql.split('CREATE TRIGGER trg_authentication_events_no_update').slice(1))
      .at(-1)
      ?.split('END$$')[0];
    const redacted = ['ip', 'user_agent', 'client_hints'];
    // A Drizzle table carries its columns as its own enumerable properties.
    for (const { name } of Object.values(authenticationEvents) as { name: string }[]) {
      expect(body, name).toContain(
        redacted.includes(name) ? `NEW.${name} IS NULL` : `NEW.${name} <=> OLD.${name}`,
      );
    }
  });

  it('runs no statement the erasure credential is not granted (users.sql census)', async () => {
    // ACCOUNTFIX. Every table each statement names, with the privilege that statement needs: a
    // write needs SELECT as well, because it filters on a column it reads. erasureGrants() is what
    // `users-sql.test.ts` holds `tmanage_erasure` to, so a new statement here without its grant
    // fails this case before it fails with errno 1142 on a least-privilege server.
    const missing = new Set<string>();
    for (const answers of [{}, { member: true }]) {
      const { database, statements } = fakeDatabase(answers);
      await new AccountErasure(database).run(context, USER);
      for (const { sql } of statements) {
        const verb = sql.split(' ')[0]?.toUpperCase() ?? '';
        const target = /^(?:update|delete from) `([a-z0-9_]+)`/u.exec(sql)?.[1];
        const needs: [string, string][] = [
          ...[...sql.matchAll(/(?:from|join|update) `([a-z0-9_]+)`/gu)].map(
            (match): [string, string] => [match[1] as string, 'SELECT'],
          ),
          ...(target === undefined ? [] : [[target, verb] as [string, string]]),
        ];
        for (const [table, privilege] of needs) {
          const held: readonly string[] = erasureGrants()[table] ?? [];
          if (!held.includes(privilege)) missing.add(`${privilege} ${table}`);
        }
      }
    }
    expect([...missing].sort()).toEqual([]);
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
