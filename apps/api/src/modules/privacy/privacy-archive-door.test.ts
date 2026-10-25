import { describe, expect, it } from 'vitest';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import { PrivacyArchiveBuilder, archiveDoorOf } from './privacy-archive.repository.js';
import type { ArchiveHeader } from './privacy-archive.repository.js';

/**
 * S13 / F46 regression: an owner's member export carries only the sign-in attempts made while the
 * person belonged to this organization, without address or device; the person's own export keeps
 * their whole history.
 */

const ORG = '0190c0de-0000-7000-8000-00000000000a';
const SUBJECT = '0190c0de-0000-7000-8000-000000000001';
const OWNER = '0190c0de-0000-7000-8000-000000000002';
const JOINED = new Date('2026-06-01T00:00:00.000Z');

const context = { organizationId: ORG, correlationId: 'c' } as unknown as TenantContext;

const header: ArchiveHeader = {
  format: 'tmanage-data-export',
  formatVersion: 1,
  kind: 'member',
  organization: { id: ORG, name: 'Northstar Studio' },
  subjectUserId: SUBJECT,
  generatedAt: new Date(0).toISOString(),
};

/** The person's platform-wide log: one attempt from before they joined, one after. */
const EVENTS = [
  {
    action: 'sign_in',
    outcome: 'succeeded',
    ip: '198.51.100.7',
    user_agent: 'Elsewhere/1.0',
    occurred_at: new Date('2026-01-10T09:00:00.000Z'),
  },
  {
    action: 'sign_in',
    outcome: 'succeeded',
    ip: '203.0.113.9',
    user_agent: 'Here/2.0',
    occurred_at: new Date('2026-07-02T09:00:00.000Z'),
  },
];

/**
 * A scripted database that answers the statements the way the server would: the membership row
 * for this org, and `authentication_events` filtered by the bound `occurred_at` window and cut to
 * the selected columns.
 */
function fakeDatabase(membership: Record<string, unknown> | null) {
  const identitySql: string[] = [];
  const database = {
    read: (_c: TenantContext, work: (runner: unknown) => Promise<unknown>) =>
      work({
        query: (sql: string, params: unknown[]) => {
          if (sql.includes('from memberships')) {
            expect(params).toEqual([ORG, SUBJECT]);
            return Promise.resolve(membership ? [membership] : []);
          }
          return Promise.resolve([]);
        },
      }),
    identityRead: (_o: unknown, work: (runner: unknown) => Promise<unknown>) =>
      work({
        query: (sql: string, params: unknown[]) => {
          identitySql.push(sql);
          if (sql.includes('from users')) return Promise.resolve([{ id: SUBJECT }]);
          const from = params[1] instanceof Date ? params[1] : null;
          const to = params[2] instanceof Date ? params[2] : null;
          const columns = /select (.*?)\s+from/su
            .exec(sql)?.[1]
            ?.split(',')
            .map((c) => c.trim());
          const rows = EVENTS.filter(
            (event) =>
              (from === null || event.occurred_at >= from) &&
              (to === null || event.occurred_at <= to),
          ).map((event) =>
            Object.fromEntries(
              Object.entries(event).filter(([key]) => columns?.includes(key) ?? false),
            ),
          );
          return Promise.resolve(rows);
        },
      }),
  } as unknown as TenantDatabase;
  return { database, identitySql };
}

const done = () => Promise.resolve();

describe('F46 — the owner door bounds sign-in history to the membership', () => {
  it('leaves out attempts from before the person joined, and every ip and user agent', async () => {
    const { database, identitySql } = fakeDatabase({
      created_at: JOINED,
      status: 'active',
      updated_at: JOINED,
    });
    const document = await new PrivacyArchiveBuilder(database).build(
      context,
      header,
      done,
      'owner',
    );
    const history = document.sections['sign_in_history'] ?? [];
    expect(history).toEqual([
      { action: 'sign_in', outcome: 'succeeded', occurred_at: '2026-07-02T09:00:00.000Z' },
    ]);
    expect(JSON.stringify(history)).not.toContain('198.51.100.7');
    const signInSql = identitySql.find((sql) => sql.includes('authentication_events')) ?? '';
    expect(signInSql).not.toMatch(/\bip\b|user_agent/u);
    expect(signInSql).toContain('occurred_at >= ?');
  });

  it('defaults to the owner reading when no door is named', async () => {
    const { database } = fakeDatabase({ created_at: JOINED, status: 'active', updated_at: JOINED });
    const document = await new PrivacyArchiveBuilder(database).build(context, header, done);
    expect(document.sections['sign_in_history']).toHaveLength(1);
  });

  it('ends the window at offboarding', async () => {
    const { database } = fakeDatabase({
      created_at: new Date('2025-01-01T00:00:00.000Z'),
      status: 'offboarded',
      updated_at: new Date('2026-03-01T00:00:00.000Z'),
    });
    const document = await new PrivacyArchiveBuilder(database).build(
      context,
      header,
      done,
      'owner',
    );
    expect(document.sections['sign_in_history']).toEqual([
      { action: 'sign_in', outcome: 'succeeded', occurred_at: '2026-01-10T09:00:00.000Z' },
    ]);
  });

  it('gives nothing when the membership cannot be read', async () => {
    const { database } = fakeDatabase(null);
    const document = await new PrivacyArchiveBuilder(database).build(
      context,
      header,
      done,
      'owner',
    );
    expect(document.sections['sign_in_history']).toEqual([]);
  });
});

describe('F46 — the person’s own door keeps the whole history', () => {
  it('includes the attempts from before they joined, with ip and user agent', async () => {
    const { database } = fakeDatabase({ created_at: JOINED, status: 'active', updated_at: JOINED });
    const document = await new PrivacyArchiveBuilder(database).build(context, header, done, 'self');
    const history = document.sections['sign_in_history'] ?? [];
    expect(history).toHaveLength(2);
    expect(JSON.stringify(history)).toContain('198.51.100.7');
    expect(JSON.stringify(history)).toContain('Here/2.0');
  });

  it('is the self door only when the subject asked about themselves', () => {
    expect(archiveDoorOf({ requestedByUserId: SUBJECT, subjectUserId: SUBJECT })).toBe('self');
    expect(archiveDoorOf({ requestedByUserId: OWNER, subjectUserId: SUBJECT })).toBe('owner');
    expect(archiveDoorOf({ requestedByUserId: OWNER, subjectUserId: null })).toBe('owner');
  });
});
