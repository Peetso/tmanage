import { describe, expect, it, vi } from 'vitest';
import type { TenantDatabase } from '../../../common/database/tenant-context.js';
import type { PlatformAdminActor } from '../platform-admin.guard.js';
import type { PlatformAdminRepository } from '../platform-admin.repository.js';
import { PLATFORM_METADATA_REASON } from '../platform-admin.repository.js';
import {
  PEOPLE_METADATA_TABLES,
  PEOPLE_SQL,
  PlatformPeopleRepository,
  peopleWhere,
} from './people.repository.js';
import { PlatformPeopleService, parsePeopleFilter } from './people.service.js';

/**
 * Platform admin v2 · People (PA-06). The real service over the real repository, on a database
 * double that records every statement with the path it ran on:
 *
 * - the B1 filters become SQL on the METADATA path (`bootstrapRead`, the platform reason, the
 *   declared tables), never a tenant transaction;
 * - a taken email answers 409 and writes nothing else;
 * - disable needs a reason; enable does not;
 * - reset two-step disables every factor AND every unused recovery code, in one transaction.
 */

const PERSON = '0199aa00-0000-7000-8000-0000000000d1';
const OTHER = '0199aa00-0000-7000-8000-0000000000d2';
const ORG = '0199aa00-0000-7000-8000-0000000000c1';
const REASON = 'Ticket #4821 — owner asked';
const ctx = {
  correlationId: '0199aa00-0000-7000-8000-0000000000e1',
  ip: '41.33.10.8',
  userAgent: 'Firefox',
};
const actor: PlatformAdminActor = {
  account: {
    userId: '0199aa00-0000-7000-8000-0000000000a1',
    email: 'peter@peetrix.com',
    displayName: 'Peter',
    emailVerified: true,
    mfaEnabled: true,
  },
  sessionId: 's',
  stepUp: null,
};

interface Statement {
  readonly path: 'metadata' | 'identityRead' | 'identityTransaction';
  readonly sql: string;
  readonly params: readonly unknown[];
  readonly reason?: string;
  readonly tables?: readonly string[];
}

const PERSON_ROW = {
  id: PERSON,
  email: 'maya@northstar.studio',
  display_name: 'Maya Hassan',
  locale: 'en',
  timezone: 'Africa/Cairo',
  email_verified_at: new Date('2026-03-01T00:00:00Z'),
  created_at: new Date('2026-03-01T00:00:00Z'),
  last_sign_in_at: null,
  last_sign_in_user_agent: null,
  factors: 1,
  live_sessions: 2,
  disabled_at: null,
  disabled_reason: null,
  disabled_by_email: null,
  two_step_required_at: null,
};

function world(options: { emailTakenBy?: string } = {}) {
  const statements: Statement[] = [];
  const answer = (sql: string): unknown => {
    const text = sql.trim().toLowerCase();
    if (text.startsWith('select')) {
      if (text.includes('from users u where u.id = ?')) return [PERSON_ROW];
      if (sql === PEOPLE_SQL.emailOwner)
        return options.emailTakenBy ? [{ id: options.emailTakenBy }] : [];
      return [];
    }
    return { affectedRows: 1 };
  };
  const runner = (base: Omit<Statement, 'sql' | 'params'>) => ({
    query: async (sql: string, params: readonly unknown[] = []) => {
      statements.push({ ...base, sql, params });
      return answer(sql);
    },
  });
  const database = {
    bootstrapRead: <T>(
      o: { reason: string; tables: readonly string[] },
      work: (db: unknown) => Promise<T>,
    ) => work(runner({ path: 'metadata', reason: o.reason, tables: o.tables })),
    identityRead: <T>(o: { tables: readonly string[] }, work: (db: unknown) => Promise<T>) =>
      work(runner({ path: 'identityRead', tables: o.tables })),
    identityTransaction: <T>(o: { tables: readonly string[] }, work: (tx: unknown) => Promise<T>) =>
      work(runner({ path: 'identityTransaction', tables: o.tables })),
    read: () => Promise.reject(new Error('People never opens a tenant read here')),
    transaction: () => Promise.reject(new Error('People never opens a tenant transaction')),
  } as unknown as TenantDatabase;
  const changes: { action: string; userId: string }[] = [];
  const repository = new PlatformPeopleRepository(database, {
    recordCredentialChange: async (_runner: unknown, input: { action: string; userId: string }) => {
      changes.push({ action: input.action, userId: input.userId });
    },
  } as never);
  const resets = { request: vi.fn(async () => ({})) };
  const notices = { notify: vi.fn(async () => ({})) };
  const service = new PlatformPeopleService(
    {} as PlatformAdminRepository,
    repository,
    resets,
    notices,
    () => new Date('2026-10-29T10:00:00Z'),
  );
  const writes = () => statements.filter((s) => s.path === 'identityTransaction');
  return { service, statements, writes, changes, resets, notices };
}

describe('B1 filters (PA-06)', () => {
  it('every filter becomes a bound clause; nothing from the query is spliced into SQL', () => {
    const filter = parsePeopleFilter({
      q: 'zeyad@',
      status: 'disabled',
      verified: 'false',
      mfa: 'true',
      locale: 'ar',
      organizationId: ORG,
      role: 'owner',
      signInFrom: '2026-09-29',
      hasSessions: 'true',
    });
    const where = peopleWhere(filter);
    expect(where.sql).toContain('(u.email like ? or u.display_name like ? or u.id = ?)');
    expect(where.sql).toContain('u.disabled_at is not null');
    expect(where.sql).toContain('u.email_verified_at is null');
    expect(where.sql).toContain('user_mfa_factors f');
    expect(where.sql).toContain('u.locale = ?');
    expect(where.sql).toContain('m.organization_id = ? and m.role = ?');
    expect(where.sql).toContain('client_memberships cm');
    expect(where.sql).not.toContain('zeyad');
    expect(where.sql).not.toContain(ORG);
    expect(where.params).toEqual(
      expect.arrayContaining(['ar', ORG, 'owner', new Date('2026-09-29T00:00:00.000Z')]),
    );
  });

  it('`email` is an alias of `q`; a bad organization id or limit is a 400', () => {
    expect(parsePeopleFilter({ email: 'maya@' }).q).toBe('maya@');
    expect(() => parsePeopleFilter({ organizationId: "x' or 1=1" })).toThrow();
    expect(() => parsePeopleFilter({ limit: '500' })).toThrow();
  });

  it('the list runs on the metadata path with the platform reason and declared tables', async () => {
    const { service, statements } = world();
    await service.list({ organizationId: ORG, status: 'active' }, ctx);
    const list = statements.filter((s) => s.sql.includes('from users u'));
    expect(list.length).toBeGreaterThan(0);
    for (const statement of list) {
      expect(statement.path).toBe('metadata');
      expect(statement.reason).toBe(PLATFORM_METADATA_REASON);
      expect(statement.tables).toEqual([...PEOPLE_METADATA_TABLES]);
    }
    expect(list[0]?.params).toContain(ORG);
    expect(statements.some((s) => s.path === 'identityTransaction')).toBe(false);
  });
});

describe('B2 profile (PA-06)', () => {
  it('a taken email answers 409 and changes nothing', async () => {
    const { service, writes, changes, resets } = world({ emailTakenBy: OTHER });
    await expect(
      service.updateProfile(actor, PERSON, { email: 'taken@northstar.studio' }, ctx),
    ).rejects.toMatchObject({
      status: 409,
      code: 'conflict',
      auditCode: 'platform_people:email_taken',
    });
    expect(writes().map((s) => s.sql)).toEqual([PEOPLE_SQL.emailOwner]);
    expect(changes).toEqual([]);
    expect(resets.request).not.toHaveBeenCalled();
  });

  it('a new email clears verification, ends sessions, records email_changed and mails both', async () => {
    const { service, writes, changes, resets, notices } = world();
    await service.updateProfile(actor, PERSON, { email: 'maya.h@northstar.studio' }, ctx);
    const sql = writes().map((s) => s.sql);
    expect(sql.some((s) => s.includes('email_verified_at = null'))).toBe(true);
    expect(sql).toContain(PEOPLE_SQL.revokeSessions);
    expect(changes).toEqual([{ action: 'email_changed', userId: PERSON }]);
    expect(resets.request).toHaveBeenCalledWith('maya.h@northstar.studio', ctx);
    expect(notices.notify).toHaveBeenCalledWith(
      expect.objectContaining({
        oldEmail: 'maya@northstar.studio',
        newEmail: 'maya.h@northstar.studio',
      }),
    );
  });
});

describe('B3 security (PA-06)', () => {
  it('disable requires a reason and writes nothing without one', async () => {
    const { service, writes } = world();
    await expect(service.disable(actor, PERSON, {}, ctx)).rejects.toMatchObject({ status: 400 });
    await expect(service.disable(actor, PERSON, { reason: 'no' }, ctx)).rejects.toMatchObject({
      status: 400,
    });
    expect(writes()).toEqual([]);
  });

  it('disable with a reason blocks sign-in, ends sessions and audits the reason', async () => {
    const { service, writes } = world();
    await service.disable(actor, PERSON, { reason: REASON }, ctx);
    const disable = writes().find((s) => s.sql === PEOPLE_SQL.disable);
    expect(disable?.params).toEqual([REASON, PERSON]);
    expect(writes().some((s) => s.sql === PEOPLE_SQL.revokeSessions)).toBe(true);
    const audit = writes().find((s) => s.sql.includes('platform_admin_audit_events'));
    expect(audit?.params).toEqual(expect.arrayContaining(['platform.user_disabled', REASON]));
  });

  it('an operator cannot disable their own account', async () => {
    const { service } = world();
    await expect(
      service.disable(actor, actor.account.userId, { reason: REASON }, ctx),
    ).rejects.toMatchObject({ status: 409 });
  });

  it('enable clears the block; the reason is optional', async () => {
    const { service, writes } = world();
    await service.enable(actor, PERSON, {}, ctx);
    expect(writes().map((s) => s.sql)).toContain(PEOPLE_SQL.enable);
    const audit = writes().find((s) => s.sql.includes('platform_admin_audit_events'));
    expect(audit?.params).toEqual(expect.arrayContaining(['platform.user_enabled']));
  });

  it('reset two-step disables factors AND recovery codes, requires enrolment, one transaction', async () => {
    const { service, writes, changes } = world();
    await expect(service.resetTwoStep(actor, PERSON, {}, ctx)).rejects.toMatchObject({
      status: 400,
    });
    expect(writes()).toEqual([]);

    await service.resetTwoStep(actor, PERSON, { reason: REASON }, ctx);
    const sql = writes().map((s) => s.sql);
    expect(sql).toContain(PEOPLE_SQL.disableFactors);
    expect(sql).toContain(PEOPLE_SQL.revokeRecoveryCodes);
    expect(sql).toContain(PEOPLE_SQL.setTwoStepRequired(true));
    expect(sql).not.toContain(PEOPLE_SQL.revokeSessions);
    expect(changes).toEqual([{ action: 'mfa_factor_disabled', userId: PERSON }]);
  });

  it('reset two-step with "also sign her out" ends the sessions too', async () => {
    const { service, writes } = world();
    await service.resetTwoStep(actor, PERSON, { reason: REASON, signOut: true }, ctx);
    expect(writes().map((s) => s.sql)).toContain(PEOPLE_SQL.revokeSessions);
  });
});
