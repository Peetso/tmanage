import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import type { Principal } from '@tmanage/domain';
import { REQUIRED_CAPABILITY } from '../../common/http/decorators.js';
import { InvoicesController, InvoicesService } from './invoices.controller.js';
import type { InvoicesRepository, ListInvoicesOptions } from './invoices.repository.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { InvoiceRow } from '../../common/database/schema.js';

/**
 * FEAT: Billing invoice history (x179) — the read surface over fakes with **real** `authorize()`.
 *
 * The fakes stand in only for the database and the repository. `authorize()` is the real policy, so
 * these cases prove the actual security decisions: an owner (`org.manage`) may list the tenant's
 * invoices newest first and read one by id; a member without `org.manage` is refused 403; an unknown
 * or cross-tenant id is a 404 (resolve-before-authorize, so it never reveals whether the id exists in
 * another tenant); and amounts are integer cents. No DB in this suite (the chain owns the round-trip
 * and the migrator proof).
 */

const ORG = 'org-under-test';
const OWNER = 'user-owner-1';

/** An owner with org-wide scope — holds `org.manage`. */
function owner(): Principal {
  return {
    userId: OWNER,
    organizationId: ORG,
    kind: 'internal',
    role: 'owner',
    membershipId: 'membership-owner-1',
    membershipStatus: 'active',
    clientOrganizationId: null,
    projectIds: [],
    hasOrgWideScope: true,
  };
}

/** A plain member — never holds `org.manage`. */
function member(): Principal {
  return {
    userId: 'user-member-1',
    organizationId: ORG,
    kind: 'internal',
    role: 'member',
    membershipId: 'membership-member-1',
    membershipStatus: 'active',
    clientOrganizationId: null,
    projectIds: [],
    hasOrgWideScope: false,
  };
}

const context = { organizationId: ORG, userId: OWNER } as unknown as TenantContext;

function fakeDatabase(): TenantDatabase {
  const runner = {} as never;
  return {
    read: <T>(_c: TenantContext, work: (db: never) => Promise<T>): Promise<T> => work(runner),
    transaction: <T>(_c: TenantContext, work: (db: never) => Promise<T>): Promise<T> => work(runner),
  } as unknown as TenantDatabase;
}

function row(id: string, issuedAt: string, amountCents: number): InvoiceRow {
  return {
    id,
    organizationId: ORG,
    number: `INV-${id}`,
    periodStart: new Date('2026-08-01T00:00:00.000Z'),
    periodEnd: new Date('2026-08-31T23:59:59.000Z'),
    amountCents,
    currency: 'USD',
    status: 'open',
    lineItems: [{ description: 'Plan', quantity: 1, unitAmountCents: amountCents, amountCents }],
    issuedAt: new Date(issuedAt),
    createdAt: new Date(issuedAt),
  } as unknown as InvoiceRow;
}

/** A store the repository reads from: `list` returns issued-desc, `findById` resolves by id. */
function fakeRepo(rows: readonly InvoiceRow[]): InvoicesRepository {
  return {
    list: (_r: never, _c: TenantContext, _o: ListInvoicesOptions) =>
      Promise.resolve(
        [...rows].sort((a, b) => b.issuedAt.getTime() - a.issuedAt.getTime()),
      ),
    findById: (_r: never, _c: TenantContext, id: string) =>
      Promise.resolve(rows.find((r) => r.id === id) ?? null),
  } as unknown as InvoicesRepository;
}

function serviceFor(rows: readonly InvoiceRow[]): InvoicesService {
  return new InvoicesService(fakeDatabase(), fakeRepo(rows));
}

describe('InvoicesService (x179)', () => {
  const rows = [row('a', '2026-07-01T00:00:00.000Z', 1000), row('b', '2026-09-01T00:00:00.000Z', 2500)];

  it('lists the tenant invoices newest issued first, amounts in integer cents', async () => {
    const listed = await serviceFor(rows).list(context, owner());
    expect(listed.map((i) => i.id)).toEqual(['b', 'a']);
    expect(listed[0]).toMatchObject({ amountCents: 2500, currency: 'USD', number: 'INV-b' });
    expect(Number.isInteger(listed[0]?.amountCents)).toBe(true);
  });

  it('returns one invoice by id with its line items', async () => {
    const detail = await serviceFor(rows).detail(context, owner(), 'a');
    expect(detail).toMatchObject({ id: 'a', amountCents: 1000 });
    expect(detail.lineItems).toEqual([
      { description: 'Plan', quantity: 1, unitAmountCents: 1000, amountCents: 1000 },
    ]);
  });

  it('answers 404 for an unknown or cross-tenant id, before any capability check', async () => {
    // Resolve-before-authorize: even an owner gets 404 for an id that does not resolve in-tenant.
    await expect(serviceFor(rows).detail(context, owner(), 'elsewhere')).rejects.toMatchObject({
      status: 404,
    });
  });

  it('refuses a caller without org.manage with 403', async () => {
    await expect(serviceFor(rows).list(context, member())).rejects.toMatchObject({ status: 403 });
    // The id resolves, but the member still cannot read it — 403, not 404.
    await expect(serviceFor(rows).detail(context, member(), 'a')).rejects.toMatchObject({
      status: 403,
    });
  });
});

describe('invoices route capabilities', () => {
  const capabilityOf = (proto: object, key: string): unknown =>
    Reflect.getMetadata(REQUIRED_CAPABILITY, (proto as Record<string, unknown>)[key] as object);

  it('guards the list and detail with org.manage', () => {
    expect(capabilityOf(InvoicesController.prototype, 'list')).toBe('org.manage');
    expect(capabilityOf(InvoicesController.prototype, 'detail')).toBe('org.manage');
  });
});
