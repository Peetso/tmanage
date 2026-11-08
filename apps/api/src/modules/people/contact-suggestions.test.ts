import { describe, expect, it } from 'vitest';
import type { Principal } from '@tmanage/domain';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import { requireInviter } from './contact-suggestions.controller.js';
import { ContactSuggestionsService } from './contact-suggestions.service.js';
import type { ContactSuggestionsRepository } from './contact-suggestions.repository.js';

const ORG = '01900000-0000-7000-8000-000000000001';
const ctx = (userId: string) => ({ organizationId: ORG, userId }) as unknown as TenantContext;
const db = {
  read: async (_c: unknown, work: (r: unknown) => unknown) => work({}),
  transaction: async (_c: unknown, work: (r: unknown) => unknown) => work({}),
} as unknown as TenantDatabase;

/** A fake store keyed the way the SQL is: (org, user) → email set. */
function service() {
  const rows = new Map<string, Set<string>>();
  const mine = (c: TenantContext) =>
    rows.get(c.userId) ?? rows.set(c.userId, new Set()).get(c.userId)!;
  const repo = {
    deleteExpired: async () => undefined,
    existingEmails: async (_r: unknown, c: TenantContext, emails: string[]) =>
      new Set(emails.filter((e) => mine(c).has(e))),
    upsert: async (_r: unknown, c: TenantContext, _s: unknown, list: { email: string }[]) =>
      list.forEach((x) => mine(c).add(x.email)),
    suggest: async (_r: unknown, c: TenantContext, q: string) =>
      [...mine(c)]
        .filter((e) => e.startsWith(q))
        .map((email) => ({ email, displayName: null, company: null })),
  } as unknown as ContactSuggestionsRepository;
  const clientRows: { id: string; name: string }[] = [{ id: 'c1', name: 'Acme' }];
  const clients = {
    list: async () => clientRows,
    create: async (_r: unknown, _c: unknown, input: { name: string }) => {
      const row = { id: `c${clientRows.length + 1}`, name: input.name };
      clientRows.push(row);
      return row;
    },
  } as never;
  const writes = { upserts: 0 };
  const counted = {
    ...repo,
    upsert: async (...args: unknown[]) => {
      writes.upserts += 1;
      return (repo.upsert as (...a: unknown[]) => Promise<void>)(...args);
    },
  } as unknown as ContactSuggestionsRepository;
  return Object.assign(
    new ContactSuggestionsService(db, counted, {
      audit: { append: async () => ({}) as never },
      clients,
    }),
    { clientRows, writes },
  );
}

const principal = (role: string) =>
  ({
    userId: 'A',
    organizationId: ORG,
    kind: 'internal',
    role,
    membershipId: 'm',
    membershipStatus: 'active',
    clientOrganizationId: null,
    projectIds: [],
    hasOrgWideScope: true,
  }) as unknown as Principal;

describe('54-11 contact suggestions', () => {
  it('AUTH: imports count new vs refreshed, and user B never sees user A rows', async () => {
    const s = service();
    const body = { format: 'csv', text: 'email\na@x.io\nb@x.io' };
    expect(await s.importFile(ctx('A'), body)).toMatchObject({ imported: 2, updated: 0 });
    expect(await s.importFile(ctx('A'), body)).toMatchObject({ imported: 0, updated: 2 });
    expect(await s.suggest(ctx('A'), 'a')).toHaveLength(1);
    expect(await s.suggest(ctx('B'), 'a')).toEqual([]);
  });

  it('refuses text over 2 MB (413) and the 11th import in an hour (429)', async () => {
    const s = service();
    await expect(
      s.importFile(ctx('A'), { format: 'csv', text: 'é'.repeat(1_048_577) }),
    ).rejects.toMatchObject({ status: 413 });
    for (let i = 0; i < 10; i += 1) await s.importFile(ctx('A'), { format: 'vcard', text: 'x' });
    await expect(s.importFile(ctx('A'), { format: 'vcard', text: 'x' })).rejects.toMatchObject({
      status: 429,
    });
  });

  it('AUTH: only internal inviters pass (manager yes, member and client_admin no)', () => {
    const p = (role: string, kind = 'internal') =>
      ({
        userId: 'A',
        organizationId: ORG,
        kind,
        role,
        membershipId: 'm',
        membershipStatus: 'active',
        clientOrganizationId: kind === 'client' ? 'c' : null,
        projectIds: [],
        hasOrgWideScope: true,
      }) as unknown as Principal;
    expect(() => requireInviter(p('manager'), ctx('A'))).not.toThrow();
    expect(() => requireInviter(p('member'), ctx('A'))).toThrow();
    expect(() => requireInviter(p('client_admin', 'client'), ctx('A'))).toThrow();
  });

  it('r46 preview: duplicates by e-mail, already-mine, invalid rows and new companies; no write', async () => {
    const s = service();
    await s.importFile(ctx('A'), { format: 'csv', text: 'email\nold@x.io' });
    const csv = [
      'Who,Mail,Firm',
      'Sara,sara@x.io,Acme',
      'S2,SARA@x.io,Acme',
      'Old,old@x.io,Nile',
      'Bad,bad@,',
    ];
    const preview = await s.preview(ctx('A'), {
      format: 'csv',
      text: csv.join('\n'),
      mapping: { email: 1, name: 0, company: 2 },
    });
    expect(preview.rows.map((r) => r.status)).toEqual([
      'new',
      'duplicate',
      'existing',
      'invalid_email',
    ]);
    expect(preview.counts).toMatchObject({
      total: 4,
      new: 1,
      existing: 1,
      duplicate: 1,
      invalid: 1,
    });
    expect(preview.errors.map((e) => e.line)).toEqual([3, 5]);
    expect(preview.companies).toEqual([
      { name: 'Acme', isNew: false },
      { name: 'Nile', isNew: true },
    ]);
    expect(s.writes.upserts).toBe(1);
    await expect(
      s.preview(ctx('A'), { format: 'csv', text: csv.join('\n'), mapping: { email: 9 } }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('r46 import: createClients adds only new companies and needs org.manage', async () => {
    const s = service();
    const text = 'email,company\na@x.io,Acme\nb@x.io,Nile\nc@x.io,nile';
    await expect(
      s.importFile(ctx('A'), { format: 'csv', text, createClients: true }, principal('manager')),
    ).rejects.toMatchObject({ status: 403 });
    const done = await s.importFile(
      ctx('A'),
      { format: 'csv', text, createClients: true },
      principal('owner'),
    );
    expect(done).toMatchObject({ imported: 3, clientsCreated: 1 });
    expect(s.clientRows.map((r) => r.name)).toEqual(['Acme', 'Nile']);
  });
});
