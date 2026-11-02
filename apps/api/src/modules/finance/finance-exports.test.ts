import { describe, expect, it, vi } from 'vitest';
import type { Principal } from '@tmanage/domain';
import type { TenantContext } from '../../common/database/tenant-context.js';
import { signReauthToken } from '../identity/reauth-token.js';
import type { FinanceExportsRepository } from './finance-exports.repository.js';
import {
  CREDIT_NOTE_EXPORT_COLUMNS,
  CREDIT_NOTE_LINE_EXPORT_COLUMNS,
  CUSTOMER_EXPORT_COLUMNS,
  EXPENSE_EXPORT_COLUMNS,
  INVOICE_EXPORT_COLUMNS,
  INVOICE_LINE_EXPORT_COLUMNS,
  PAYMENT_EXPORT_COLUMNS,
} from './finance-exports.repository.js';
import { FinanceExportsService, validateExportRequest } from './finance-exports.service.js';

/**
 * 52-11 service rules over an in-memory repository: the run marks the invoices and is one
 * transaction (a failing step leaves no mark), 409 without `reexport`, 413 over the cap, a
 * `finance.view`-only caller cannot export, no step-up → 403, the `=cmd` guard through the zip,
 * and only the expenses kind carries a person's name.
 */

const ORG = '00000000-0000-7000-8000-000000000001';
const SECRET = 'test-session-secret-0123456789abcdef';
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
const NOW = new Date('2026-11-02T09:00:00Z');
const stepUp = {
  reauthToken: signReauthToken(
    { userId: 'u1', sessionId: 's1', expiresAt: new Date(NOW.getTime() + 60_000) },
    SECRET,
  ),
  sessionId: 's1',
};
const BODY = {
  target: 'generic',
  periodStart: '2026-10-01',
  periodEnd: '2026-10-31',
  kinds: ['invoices', 'customers'],
};

function invoice(id: string, exportedAt: Date | null = null) {
  return {
    id,
    number: `INV-${id}`,
    kind: 'standard',
    state: 'sent',
    issueDate: '2026-10-05',
    dueDate: '2026-10-20',
    supplyDate: null,
    currency: 'SAR',
    fxRate: null,
    subtotalMinor: 10_000,
    discountMinor: 0,
    taxMinor: 1_500,
    totalMinor: 11_500,
    poNumber: null,
    notes: null,
    terms: null,
    customerId: 'c1',
    customerName: 'Acme',
    customerNameAr: null,
    customerEmail: null,
    customerAddress: null,
    exportedAt,
    lines: [],
  };
}

function world(options: { invoices?: ReturnType<typeof invoice>[]; failMark?: boolean } = {}) {
  const invoices = options.invoices ?? [invoice('i1')];
  const committed = { marked: [] as string[], exports: 0, audits: [] as unknown[] };
  const repository = {
    invoices: vi.fn(async (_r: unknown, _o: string, _f: string, _t: string, limit: number) =>
      invoices.slice(0, limit),
    ),
    invoiceLines: async () =>
      new Map([
        [
          'i1',
          [
            {
              position: 0,
              descriptionEn: '=cmd|"/c calc"!A1',
              descriptionAr: null,
              quantityCenti: 100,
              unit: 'item',
              unitPriceMinor: 10_000,
              discountBp: 0,
              taxBp: 1500,
              taxCategory: 'S',
              lineDiscountMinor: 0,
              lineNetMinor: 10_000,
              lineTaxMinor: 1_500,
              lineGrossMinor: 11_500,
            },
          ],
        ],
      ]),
    creditNotes: async () => [],
    payments: async () => [],
    customers: async () => [
      {
        id: 'c1',
        name: 'Acme',
        legalNameEn: null,
        legalNameAr: null,
        taxRegistrationNo: null,
        billingAddressEn: null,
        billingAddressAr: null,
        billingEmail: null,
        defaultCurrency: 'SAR',
      },
    ],
    expenses: async () => [
      {
        id: 'e1',
        spentOn: '2026-10-07',
        category: 'travel',
        amountMinor: 5_000,
        currency: 'SAR',
        taxBp: 0,
        billable: false,
        markupBp: 0,
        note: 'Taxi',
        submitterName: 'Sara Ali',
      },
    ],
    insertExport: vi.fn(async () => undefined),
    markInvoicesExported: vi.fn(async (_r: unknown, _o: string, ids: string[]) => {
      if (options.failMark === true) throw new Error('lock wait timeout');
      return ids;
    }),
    listExports: async () => [],
  } as unknown as FinanceExportsRepository;
  // The fake transaction commits only when the work resolves — the engine's all-or-nothing.
  const transaction = vi.fn(async (_c: unknown, work: (tx: unknown) => Promise<unknown>) => {
    const staged = { marked: [] as string[], exports: 0, audits: [] as unknown[] };
    const tx = { staged };
    const markSpy = repository.markInvoicesExported as unknown as ReturnType<typeof vi.fn>;
    markSpy.mockImplementation(async (_r: unknown, _o: string, ids: string[]) => {
      if (options.failMark === true) throw new Error('lock wait timeout');
      staged.marked.push(...ids);
    });
    (repository.insertExport as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      async () => {
        staged.exports += 1;
      },
    );
    audit.record.mockImplementation(async (_r: unknown, _c: unknown, input: unknown) => {
      staged.audits.push(input);
    });
    const result = await work(tx);
    committed.marked.push(...staged.marked);
    committed.exports += staged.exports;
    committed.audits.push(...staged.audits);
    return result;
  });
  const audit = { record: vi.fn() };
  const service = new FinanceExportsService({
    database: { transaction, read: transaction } as never,
    repository,
    audit: audit as never,
    sessionSecret: SECRET,
    now: () => NOW,
  });
  return { service, repository, committed, transaction };
}

describe('POST finance/exports (52-11)', () => {
  it('marks the exported invoices, writes one history row and one audit row, in one transaction', async () => {
    const { service, committed, transaction } = world();
    const download = await service.create(context, owner, BODY, stepUp);
    expect(transaction).toHaveBeenCalledTimes(1);
    expect(committed.marked).toEqual(['i1']);
    expect(committed.exports).toBe(1);
    expect(committed.audits).toHaveLength(1);
    expect(committed.audits[0]).toMatchObject({
      action: 'finance.exported',
      metadata: { target: 'generic', invoices_count: 1, customers_count: 1 },
    });
    expect(download.filename).toBe('tmanage-generic-2026-10-01_2026-10-31.zip');
    expect(download.manifestSha256).toMatch(/^[0-9a-f]{64}$/u);
    // UNIT-52-16 through the zip: STORE keeps the CSV bytes verbatim.
    const bytes = download.zip.toString('utf8');
    expect(bytes).toContain(`'=cmd|""/c calc""!A1`);
    expect(bytes).not.toMatch(/,=cmd/u);
    expect(bytes).toContain('README-generic.txt');
    expect(bytes).toContain('manifest.json');
  });

  it('a failing step leaves no exported mark and no history row', async () => {
    const { service, committed } = world({ failMark: true });
    await expect(service.create(context, owner, BODY, stepUp)).rejects.toThrow('lock wait');
    expect(committed.marked).toEqual([]);
    expect(committed.exports).toBe(0);
    expect(committed.audits).toEqual([]);
  });

  it('409 already_exported without reexport; reexport goes through', async () => {
    const { service } = world({ invoices: [invoice('i1', new Date('2026-10-30T00:00:00Z'))] });
    await expect(service.create(context, owner, BODY, stepUp)).rejects.toMatchObject({
      status: 409,
      message: 'already_exported',
      details: [{ field: 'already_exported', message: '1' }],
    });
    await expect(
      service.create(context, owner, { ...BODY, reexport: true }, stepUp),
    ).resolves.toMatchObject({ filename: expect.stringContaining('generic') });
  });

  it('413 export_too_large over 5,000 invoices', async () => {
    const many = Array.from({ length: 5_001 }, (_, i) => invoice(`i${i}`));
    const { service } = world({ invoices: many });
    await expect(service.create(context, owner, BODY, stepUp)).rejects.toMatchObject({
      status: 413,
      message: 'export_too_large',
    });
  });

  it('a finance.view-only caller cannot export; no step-up is a 403 reauthentication_required', async () => {
    const { service } = world();
    await expect(service.create(context, principal('manager'), BODY, stepUp)).rejects.toMatchObject(
      { status: 403, code: 'forbidden' },
    );
    await expect(service.create(context, owner, BODY, {})).rejects.toMatchObject({
      status: 403,
      code: 'reauthentication_required',
    });
  });

  it('only the expenses kind carries a person name', async () => {
    const { service } = world();
    const without = await service.create(context, owner, BODY, stepUp);
    expect(without.zip.toString('utf8')).not.toContain('Sara Ali');
    const withExpenses = await service.create(
      context,
      owner,
      { ...BODY, kinds: ['expenses'] },
      stepUp,
    );
    expect(withExpenses.zip.toString('utf8')).toContain('Sara Ali');
  });

  it('validates the period (≤ 13 months) and the kinds', () => {
    expect(() =>
      validateExportRequest({ ...BODY, periodStart: '2025-01-01', periodEnd: '2026-02-01' }),
    ).toThrow();
    expect(() => validateExportRequest({ ...BODY, kinds: ['salaries'] })).toThrow();
    expect(validateExportRequest({ ...BODY, kinds: ['customers', 'invoices'] }).kinds).toEqual([
      'invoices',
      'customers',
    ]);
  });

  it('the canonical selections carry no cost, internal note or source link', () => {
    const selected = [
      INVOICE_EXPORT_COLUMNS,
      INVOICE_LINE_EXPORT_COLUMNS,
      CREDIT_NOTE_EXPORT_COLUMNS,
      CREDIT_NOTE_LINE_EXPORT_COLUMNS,
      PAYMENT_EXPORT_COLUMNS,
      CUSTOMER_EXPORT_COLUMNS,
      EXPENSE_EXPORT_COLUMNS,
    ].flatMap((columns) => Object.keys(columns));
    for (const key of selected) {
      expect(key).not.toMatch(/cost|internal|sourceIds|snapshot|rate(Card|Snapshot)/iu);
    }
  });
});
