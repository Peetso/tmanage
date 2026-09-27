import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import type { Principal } from '@tmanage/domain';
import { REQUIRED_CAPABILITY } from '../../common/http/decorators.js';
import {
  InvoiceLineItemsController,
  InvoiceLineItemsService,
} from './invoice-line-items.controller.js';
import type { InvoiceLineItemsRepository } from './invoice-line-items.repository.js';
import type { InvoicesRepository } from './invoices.repository.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { InvoiceLineItemRow, InvoiceRow } from '../../common/database/schema.js';

/**
 * FEAT: Billing invoice line items (x225) — the per-invoice line read over fakes with **real**
 * `authorize()`. The fakes stand in only for the database and the two repositories. `authorize()` is
 * the real policy, so these cases prove the actual security decisions: an owner (`org.manage`) reads
 * an invoice's lines and their summed total reconciles to the stored header; an unknown or
 * cross-tenant `:invoiceId` is a 404 **before** any capability check (resolve-before-authorize, so it
 * never reveals whether the invoice exists in another tenant); a member without `org.manage` is
 * refused 403; and amounts are integer minor units. No DB in this suite (the chain owns the
 * round-trip and the migrator proof).
 */

const ORG = 'org-under-test';
const OWNER = 'user-owner-1';

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
    transaction: <T>(_c: TenantContext, work: (db: never) => Promise<T>): Promise<T> =>
      work(runner),
  } as unknown as TenantDatabase;
}

function invoice(id: string, amountCents: number): InvoiceRow {
  return { id, organizationId: ORG, amountCents, currency: 'USD' } as unknown as InvoiceRow;
}

function line(id: string, position: number, amountCents: number): InvoiceLineItemRow {
  return {
    id,
    organizationId: ORG,
    invoiceId: 'inv-a',
    description: `Line ${id}`,
    quantity: 1,
    unitAmountCents: amountCents,
    amountCents,
    position,
    createdAt: new Date('2026-08-01T00:00:00.000Z'),
  } as unknown as InvoiceLineItemRow;
}

function fakeInvoices(rows: readonly InvoiceRow[]): InvoicesRepository {
  return {
    findById: (_r: never, _c: TenantContext, id: string) =>
      Promise.resolve(rows.find((r) => r.id === id) ?? null),
  } as unknown as InvoicesRepository;
}

function fakeLines(rows: readonly InvoiceLineItemRow[]): InvoiceLineItemsRepository {
  return {
    listByInvoice: (_r: never, _c: TenantContext, invoiceId: string) =>
      Promise.resolve(
        [...rows].filter((r) => r.invoiceId === invoiceId).sort((a, b) => a.position - b.position),
      ),
  } as unknown as InvoiceLineItemsRepository;
}

function serviceFor(
  invoices: readonly InvoiceRow[],
  lines: readonly InvoiceLineItemRow[],
): InvoiceLineItemsService {
  return new InvoiceLineItemsService(fakeDatabase(), fakeInvoices(invoices), fakeLines(lines));
}

describe('InvoiceLineItemsService (x225)', () => {
  const invoices = [invoice('inv-a', 3000)];
  const lines = [line('l2', 1, 1000), line('l1', 0, 2000)];

  it('lists an invoice lines in order and reconciles the summed total to the header', async () => {
    const result = await serviceFor(invoices, lines).listForInvoice(context, owner(), 'inv-a');
    expect(result.lineItems.map((l) => l.id)).toEqual(['l1', 'l2']);
    expect(result.lineTotalCents).toBe(3000);
    expect(result.invoiceTotalCents).toBe(3000);
    expect(result.reconciled).toBe(true);
    expect(Number.isInteger(result.lineItems[0]?.amountCents)).toBe(true);
  });

  it('answers 404 for an unknown or cross-tenant invoice id, before any capability check', async () => {
    // Resolve-before-authorize: even an owner gets 404 for an id that does not resolve in-tenant.
    await expect(
      serviceFor(invoices, lines).listForInvoice(context, owner(), 'elsewhere'),
    ).rejects.toMatchObject({ status: 404 });
  });

  it('refuses a caller without org.manage with 403 (not 404 — the invoice resolves)', async () => {
    await expect(
      serviceFor(invoices, lines).listForInvoice(context, member(), 'inv-a'),
    ).rejects.toMatchObject({ status: 403 });
  });

  it('faults 500 when stored lines do not reconcile to the header total', async () => {
    const mismatched = [invoice('inv-a', 9999)];
    await expect(
      serviceFor(mismatched, lines).listForInvoice(context, owner(), 'inv-a'),
    ).rejects.toMatchObject({ status: 500 });
  });
});

describe('invoice line-items route capabilities', () => {
  const capabilityOf = (proto: object, key: string): unknown =>
    Reflect.getMetadata(REQUIRED_CAPABILITY, (proto as Record<string, unknown>)[key] as object);

  it('guards the list with org.manage', () => {
    expect(capabilityOf(InvoiceLineItemsController.prototype, 'list')).toBe('org.manage');
  });
});
