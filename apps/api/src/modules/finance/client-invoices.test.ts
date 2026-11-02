import { describe, expect, it, vi } from 'vitest';
import type { Principal } from '@tmanage/domain';
import type { ClientInvoiceLineRow, ClientInvoiceRow } from '../../common/database/schema.js';
import type { TenantContext } from '../../common/database/tenant-context.js';
import type { ClientInvoicesRepository } from './client-invoices.repository.js';
import { ClientInvoicesService } from './client-invoices.service.js';

/**
 * 52-09 service rules over an in-memory repository: send is one transaction and retry-safe on its
 * Idempotency-Key, a second sender is a 409, a sent invoice refuses an edit, a `finance.view`-only
 * caller cannot send, an overpayment is a 400, a locked issue date is a 422, the step-up gate, and
 * the pull leaves unapproved and unpriced time out.
 */

const ORG = '00000000-0000-7000-8000-000000000001';
const CLIENT = '00000000-0000-7000-8000-0000000000c1';
const context = { organizationId: ORG, userId: 'u1' } as TenantContext;
const principal = (role: string): Principal =>
  ({
    userId: 'u1',
    organizationId: ORG,
    kind: 'internal',
    role,
    membershipId: 'm1',
    membershipStatus: 'active',
    clientOrganizationId: null,
    projectIds: [],
    hasOrgWideScope: true,
  }) as unknown as Principal;
const owner = principal('owner');

function world(options: { locked?: boolean; settings?: Record<string, string> } = {}) {
  const at = new Date('2026-11-02T09:00:00Z');
  const invoice: ClientInvoiceRow = {
    id: '00000000-0000-7000-8000-0000000000b1',
    organizationId: ORG,
    clientOrganizationId: CLIENT,
    state: 'draft',
    number: null,
    kind: 'standard',
    language: 'bi',
    documentLabel: 'invoice',
    currency: 'SAR',
    baseCurrency: 'SAR',
    fxRate: null,
    issueDate: null,
    dueDate: null,
    subtotalMinor: 0,
    discountMinor: 0,
    taxMinor: 0,
    totalMinor: 0,
    paidMinor: 0,
    depositAppliedMinor: 0,
    sendKeyHash: null,
    viewedAt: null,
    version: 1,
    createdAt: at,
    updatedAt: at,
  } as unknown as ClientInvoiceRow;
  const lines: ClientInvoiceLineRow[] = [
    {
      id: 'l1',
      invoiceId: invoice.id,
      position: 0,
      sourceType: 'time',
      quantityCenti: 1000,
      unitPriceMinor: 30_000,
      discountBp: 0,
      taxBp: 1500,
      lineNetMinor: 300_000,
      lineTaxMinor: 45_000,
      lineGrossMinor: 345_000,
      lineDiscountMinor: 0,
      sourceIdsJson: JSON.stringify(['00000000-0000-7000-8000-0000000000a1']),
    } as unknown as ClientInvoiceLineRow,
  ];
  const linked: string[] = [];
  const repository = {
    findInvoice: async () => ({ ...invoice }),
    updateInvoice: async (_r: unknown, _o: string, _id: string, change: object) => {
      Object.assign(invoice, change);
    },
    lines: async () => lines,
    payments: async () => [],
    creditNotes: async () => [],
    insertPayment: async () => undefined,
    insertEvent: async () => undefined,
    setting: async (_r: unknown, _o: string, key: string) => options.settings?.[key],
    locksHolding: async () =>
      options.locked === true ? [{ periodStart: '2026-10-01', periodEnd: '2026-11-30' }] : [],
    clientBilling: async () => ({ id: CLIENT, name: 'Acme', paymentTermsDays: 15 }),
    clientAdminUserIds: async () => ['client-admin-1'],
    linkTimeLogs: async (_r: unknown, _o: string, ids: string[]) => {
      linked.push(...ids);
      return ids.length;
    },
    approvedTime: async () => [
      {
        id: 't1',
        minutes: 90,
        spentOn: '2026-10-05',
        rateMinor: 20_000,
        workItemId: 'w1',
        title: 'Post',
        membershipId: 'm9',
        firstName: 'Sara',
      },
      {
        id: 't2',
        minutes: 60,
        spentOn: '2026-10-06',
        rateMinor: null,
        workItemId: 'w1',
        title: 'Post',
        membershipId: 'm9',
        firstName: 'Sara',
      },
    ],
    waitingMinutes: async () => 120,
    deletePulledLines: async () => undefined,
    insertLines: async (_r: unknown, rows: ClientInvoiceLineRow[]) => {
      lines.splice(0, lines.length, ...rows);
    },
  } as unknown as ClientInvoicesRepository;
  const transaction = vi.fn(async (_c: unknown, work: (r: unknown) => unknown) => work({}));
  const mailer = { send: vi.fn(async () => 'sent' as const) };
  const service = new ClientInvoicesService({
    database: { transaction, read: transaction } as never,
    repository,
    finance: {
      profile: async () => null,
      organization: async () => ({
        name: 'Studio',
        defaultLocale: 'en-SA',
        timezone: 'Asia/Riyadh',
      }),
    },
    sequences: {
      nextNumber: async () => ({
        kind: 'invoice',
        periodKey: '2026',
        value: 1,
        number: 'INV-2026-0001',
      }),
    },
    notifications: { insertForRecipient: vi.fn(async () => undefined) },
    audit: { record: vi.fn(async () => undefined) } as never,
    mailer,
    webPublicUrl: 'https://tmanage.test',
    now: () => at,
  });
  return { service, invoice, linked, transaction, mailer };
}

const meta = { orgSlug: 'studio', idempotencyKey: 'send-1' };

describe('52-09 client invoices', () => {
  it('sends in one transaction, links sources, and answers a keyed retry the same; another sender 409', async () => {
    const w = world();
    const first = await w.service.send(
      context,
      owner,
      w.invoice.id,
      { to: ['ap@acme.test'] },
      meta,
    );
    expect(w.transaction).toHaveBeenCalledTimes(1);
    expect(first).toMatchObject({ number: 'INV-2026-0001', state: 'sent', totalMinor: 345_000 });
    expect(first.contentHash).toMatch(/^[0-9a-f]{64}$/u);
    expect(w.linked).toEqual(['00000000-0000-7000-8000-0000000000a1']);
    expect(w.mailer.send).toHaveBeenCalledTimes(1);
    const retry = await w.service.send(
      context,
      owner,
      w.invoice.id,
      { to: ['ap@acme.test'] },
      meta,
    );
    expect(retry).toEqual(first);
    expect(w.mailer.send).toHaveBeenCalledTimes(1);
    await expect(
      w.service.send(context, owner, w.invoice.id, { to: ['ap@acme.test'] }, { orgSlug: 'studio' }),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      w.service.update(context, owner, w.invoice.id, { expectedVersion: 2, poNumber: 'X' }),
    ).rejects.toMatchObject({ status: 409 });
  });

  it('refuses a finance.view-only sender, a locked issue date and a large send without step-up', async () => {
    const w = world();
    await expect(
      w.service.send(context, principal('manager'), w.invoice.id, { to: ['ap@acme.test'] }, meta),
    ).rejects.toMatchObject({ status: 403 });
    const locked = world({ locked: true });
    await expect(
      locked.service.send(context, owner, locked.invoice.id, { to: ['ap@acme.test'] }, meta),
    ).rejects.toMatchObject({ status: 422 });
    const strict = world({ settings: { 'finance.step_up_send_minor': '100000' } });
    await expect(
      strict.service.send(context, owner, strict.invoice.id, { to: ['ap@acme.test'] }, meta),
    ).rejects.toMatchObject({ status: 403, code: 'reauthentication_required' });
  });

  it('records payments and refuses an overpayment with 400 unless the org allows it', async () => {
    const w = world();
    await w.service.send(context, owner, w.invoice.id, { to: ['ap@acme.test'] }, meta);
    const payment = { paidOn: '2026-11-02', amountMinor: 345_001, method: 'transfer' };
    await expect(
      w.service.recordPayment(context, owner, w.invoice.id, payment),
    ).rejects.toMatchObject({ status: 400 });
    const paid = await w.service.recordPayment(context, owner, w.invoice.id, {
      ...payment,
      amountMinor: 100_000,
    });
    expect(paid).toMatchObject({
      state: 'partially_paid',
      paidMinor: 100_000,
      amountDueMinor: 245_000,
    });
  });

  it('pulls only approved, priced time and reports what waits', async () => {
    const w = world();
    const result = await w.service.pull(context, owner, w.invoice.id, {
      period: { from: '2026-10-01', to: '2026-10-31' },
      include: { time: 'by_person' },
    });
    expect(result.waiting).toEqual({ minutes: 120 });
    expect(result.unpriced).toEqual({ minutes: 60 });
    expect(result.invoice.lines).toHaveLength(1);
    expect(result.invoice.lines[0]).toMatchObject({
      quantity: 1.5,
      unitPriceMinor: 20_000,
      groupKey: 'person:m9',
    });
  });
});
