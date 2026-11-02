import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { decodeTlv } from '@tmanage/domain';
import { createFieldCipher, loadFieldCipherKeyring } from '@tmanage/domain/field-cipher';
import { selfSignedCertificate } from '@tmanage/domain/zatca-sign';
import type { Principal } from '@tmanage/domain';
import type {
  ClientCreditNoteRow,
  ClientInvoiceLineRow,
  ClientInvoiceRow,
  OrgFinanceProfileRow,
  OrgSecretRow,
} from '../../common/database/schema.js';
import type { TenantContext } from '../../common/database/tenant-context.js';
import { REQUIRED_CAPABILITY } from '../../common/http/decorators.js';
import { ClientInvoicesController } from './client-invoices.controller.js';
import type { ClientInvoicesRepository } from './client-invoices.repository.js';
import { ClientInvoicesService, renderPrint } from './client-invoices.service.js';
import type { ClientInvoicesServiceOptions } from './client-invoices.service.js';
import { EinvoiceSigningService, SigningFailure } from './einvoice-signing.service.js';
import type { OrgSecretsRepository } from './org-secrets.repository.js';
import { GENESIS_PIH } from './einvoice-rules.js';
import { defaultProfile } from './finance-rules.js';
import type { FinanceProfileValues } from './finance-rules.js';

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

function world(
  options: {
    locked?: boolean;
    settings?: Record<string, string>;
    profile?: Partial<FinanceProfileValues>;
  } = {},
) {
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
    taxRegistrationRef: null,
    taxRegisteredAt: null,
    taxNoticeShown: false,
    notesText: null,
    termsText: null,
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
      descriptionEn: 'Design',
      descriptionAr: 'تصميم',
      unit: 'hour',
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
  const inserted: ClientInvoiceRow[] = [];
  const repository = {
    insertInvoice: async (_r: unknown, row: ClientInvoiceRow) => {
      inserted.push(row);
    },
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
  const audit = { record: vi.fn(async () => undefined) };
  const service = new ClientInvoicesService({
    database: { transaction, read: transaction } as never,
    repository,
    finance: {
      profile: async () =>
        options.profile === undefined
          ? null
          : ({
              ...defaultProfile({ name: 'Studio', defaultLocale: 'en-SA' }),
              ...options.profile,
            } as unknown as OrgFinanceProfileRow),
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
    audit: audit as never,
    mailer,
    webPublicUrl: 'https://tmanage.test',
    now: () => at,
  });
  return { service, invoice, inserted, linked, transaction, mailer, audit };
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

/** 52-28 (R19-a) — tax-document labels on the invoice: default, PATCH, tax registration, print, mail. */
describe('52-28 tax-document labels', () => {
  const saRegistered = { profile: { country: 'SA', vatRegistrationStatus: 'registered' as const } };
  const zatcaRef = '3f2b8c1e-4d5a-4b6c-8d7e-9f0a1b2c3d4e';

  it('drafts proforma for a registered SA org and invoice for an unregistered one', async () => {
    const sa = world(saRegistered);
    expect(
      (await sa.service.create(context, owner, { clientOrganizationId: CLIENT })).documentLabel,
    ).toBe('proforma');
    const plain = world({ profile: { country: 'SA' } });
    expect(
      (await plain.service.create(context, owner, { clientOrganizationId: CLIENT })).documentLabel,
    ).toBe('invoice');
  });

  it('changes a draft label (audited), refuses tax_invoice without a reference (422) and any change after send (409)', async () => {
    const w = world(saRegistered);
    await expect(
      w.service.setLabel(context, owner, w.invoice.id, { documentLabel: 'tax_invoice' }),
    ).rejects.toMatchObject({ status: 422, message: 'tax_invoice_requires_registration' });
    const changed = await w.service.setLabel(context, owner, w.invoice.id, {
      documentLabel: 'commercial',
    });
    expect(changed.documentLabel).toBe('commercial');
    expect(w.audit.record).toHaveBeenCalledWith(
      expect.anything(),
      context,
      expect.objectContaining({
        action: 'client_invoice.label_changed',
        metadata: { before: 'invoice', after: 'commercial' },
      }),
    );
    await w.service.send(context, owner, w.invoice.id, { to: ['ap@acme.test'] }, meta);
    await expect(
      w.service.setLabel(context, owner, w.invoice.id, { documentLabel: 'proforma' }),
    ).rejects.toMatchObject({ status: 409 });
  });

  it('records a tax registration after send: flips the label, audited once, idempotent, a second ref 409', async () => {
    const w = world(saRegistered);
    w.invoice.documentLabel = 'proforma';
    const sent = await w.service.send(context, owner, w.invoice.id, { to: ['ap@acme.test'] }, meta);
    expect(sent.taxNoticeShown).toBe(true);
    await expect(
      w.service.recordTaxRegistration(context, owner, w.invoice.id, {
        ref: 'not-a-uuid',
        registeredAt: '2026-11-02',
      }),
    ).rejects.toMatchObject({ status: 400 });
    const body = { ref: zatcaRef, registeredAt: '2026-11-02' };
    const registered = await w.service.recordTaxRegistration(context, owner, w.invoice.id, body);
    expect(registered).toMatchObject({
      documentLabel: 'tax_invoice',
      taxRegistrationRef: zatcaRef,
      taxNoticeShown: true,
    });
    const audits = (): number =>
      w.audit.record.mock.calls.filter(
        (call) =>
          (call as unknown[])[2] !== undefined &&
          ((call as unknown[])[2] as { action: string }).action === 'client_invoice.tax_registered',
      ).length;
    expect(audits()).toBe(1);
    const again = await w.service.recordTaxRegistration(context, owner, w.invoice.id, body);
    expect(again.documentLabel).toBe('tax_invoice');
    expect(audits()).toBe(1);
    await expect(
      w.service.recordTaxRegistration(context, owner, w.invoice.id, {
        ...body,
        ref: '9a2b8c1e-4d5a-4b6c-8d7e-9f0a1b2c3d4e',
      }),
    ).rejects.toMatchObject({ status: 409 });
  });

  it('SEC-52-21/UNIT-52-28: a SA proforma prints and mails the notice and never claims a tax invoice', async () => {
    const w = world(saRegistered);
    w.invoice.documentLabel = 'proforma';
    w.invoice.language = 'ar';
    await w.service.send(context, owner, w.invoice.id, { to: ['ap@acme.test'] }, meta);
    for (const lang of ['en', 'ar', 'bi'] as const) {
      const html = await w.service.print(context, owner, w.invoice.id, lang);
      expect(html).toContain('class="tax-notice"');
      const outsideNotice = html.replace(/<p class="tax-notice">[\s\S]*?<\/p>/u, '');
      expect(outsideNotice).not.toMatch(/tax invoice/iu);
      expect(outsideNotice).not.toContain('فاتورة ضريبية');
    }
    expect(await w.service.print(context, owner, w.invoice.id, 'ar')).toContain('فاتورة مبدئية');
    const mail = (w.mailer.send.mock.calls[0] as unknown[])[0] as { text: string };
    expect(mail.text).toContain('فاتورة مبدئية');
    expect(mail.text).toContain('ليست فاتورة ضريبية');
  });

  it('prints the reference as entered by the agency, and no notice on a tax invoice', () => {
    const view = {
      number: 'INV-1',
      documentLabel: 'tax_invoice',
      taxRegistrationRef: zatcaRef,
      currency: 'SAR',
      lines: [],
      amountInWords: { en: '', ar: '' },
      terms: null,
      notes: null,
      contentHash: null,
      issueDate: null,
      dueDate: null,
      subtotalMinor: 0,
      discountMinor: 0,
      taxMinor: 0,
      totalMinor: 0,
      amountDueMinor: 0,
    } as unknown as Parameters<typeof renderPrint>[0];
    const html = renderPrint(view, 'en', { notice: false });
    expect(html).toContain('Registered reference as entered by the agency');
    expect(html).toContain(zatcaRef);
    expect(html).not.toContain('tax-notice');
  });

  it('AUTH-52-18: the label routes need finance.manage and refuse a client principal', async () => {
    const capabilityOf = (key: string): unknown =>
      Reflect.getMetadata(
        REQUIRED_CAPABILITY,
        (ClientInvoicesController.prototype as unknown as Record<string, object>)[key]!,
      );
    expect(capabilityOf('setLabel')).toBe('finance.manage');
    expect(capabilityOf('taxRegistration')).toBe('finance.manage');
    const w = world(saRegistered);
    const client = {
      ...owner,
      kind: 'client',
      role: 'client_admin',
      clientOrganizationId: CLIENT,
    } as unknown as Principal;
    await expect(
      w.service.setLabel(context, client, w.invoice.id, { documentLabel: 'proforma' }),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      w.service.recordTaxRegistration(context, client, w.invoice.id, {
        ref: zatcaRef,
        registeredAt: '2026-11-02',
      }),
    ).rejects.toMatchObject({ status: 403 });
  });
});

/**
 * 52-12 (R21-d) UNIT-52-19: the hash chain over many invoices and credit notes through `send` /
 * `creditNote` with an in-memory repository, and the e-invoice read.
 */
function chainWorld(
  regime: 'zatca' | 'eta' | 'pint_ae',
  count: number,
  extra: Partial<ClientInvoicesServiceOptions> = {},
) {
  const at = new Date('2026-11-02T09:00:00Z');
  const rows = new Map<string, ClientInvoiceRow>();
  const notes: ClientCreditNoteRow[] = [];
  for (let i = 0; i < count; i += 1) {
    const id = `00000000-0000-7000-8000-${String(i).padStart(12, '0')}`;
    rows.set(id, {
      id,
      organizationId: ORG,
      clientOrganizationId: CLIENT,
      state: 'draft',
      number: null,
      language: 'en',
      documentLabel: 'invoice',
      currency: 'SAR',
      baseCurrency: 'SAR',
      fxRate: null,
      issueDate: null,
      dueDate: null,
      supplyDate: null,
      subtotalMinor: 0,
      discountMinor: 0,
      taxMinor: 0,
      totalMinor: 0,
      paidMinor: 0,
      depositAppliedMinor: 0,
      zatcaIcv: null,
      zatcaPih: null,
      zatcaXmlHash: null,
      zatcaStatus: 'not_applicable',
      version: 1,
      createdAt: at,
      updatedAt: at,
    } as unknown as ClientInvoiceRow);
  }
  const line = {
    id: 'l1',
    position: 0,
    sourceType: 'manual',
    descriptionEn: 'Design',
    descriptionAr: 'تصميم',
    unit: 'item',
    quantityCenti: 100,
    unitPriceMinor: 100_000,
    discountBp: 0,
    taxBp: 1500,
    taxCategory: 'S',
    lineNetMinor: 100_000,
    lineTaxMinor: 15_000,
    lineGrossMinor: 115_000,
    lineDiscountMinor: 0,
    sourceIdsJson: null,
  } as unknown as ClientInvoiceLineRow;
  const counters: Record<string, number> = {};
  const heads = (): { icv: number; xmlHash: string }[] =>
    [...rows.values(), ...notes]
      .filter((r) => r.zatcaIcv !== null)
      .map((r) => ({ icv: r.zatcaIcv!, xmlHash: r.zatcaXmlHash! }));
  const repository = {
    findInvoice: async (_r: unknown, _o: string, id: string) =>
      rows.has(id) ? { ...rows.get(id)! } : null,
    updateInvoice: async (_r: unknown, _o: string, id: string, change: object) => {
      Object.assign(rows.get(id)!, change);
    },
    lines: async () => [line],
    payments: async () => [],
    creditNotes: async (_r: unknown, _o: string, id: string) =>
      notes.filter((n) => n.invoiceId === id),
    insertCreditNote: async (_r: unknown, note: ClientCreditNoteRow) => {
      notes.push(note);
    },
    insertEvent: async () => undefined,
    setting: async () => undefined,
    locksHolding: async () => [],
    releaseLinks: async () => undefined,
    clientBilling: async () => ({ id: CLIENT, name: 'Acme', paymentTermsDays: 15 }),
    clientAdminUserIds: async () => [],
    lockChain: vi.fn(async () => undefined),
    chainHead: async () =>
      heads().reduce<{ icv: number; xmlHash: string } | null>(
        (a, b) => (a === null || b.icv > a.icv ? b : a),
        null,
      ),
  } as unknown as ClientInvoicesRepository;
  const transaction = async (_c: unknown, work: (r: unknown) => unknown) => work({});
  const service = new ClientInvoicesService({
    database: { transaction, read: transaction } as never,
    repository,
    finance: {
      profile: async () =>
        ({
          ...defaultProfile({ name: 'Studio', defaultLocale: 'en-SA' }),
          country: regime === 'eta' ? 'EG' : 'SA',
          einvoiceRegime: regime,
          legalNameAr: 'استوديو',
          taxRegistrationNo: '310122393500003',
          addressEn: 'King Fahd Rd, Riyadh',
        }) as unknown as OrgFinanceProfileRow,
      organization: async () => ({ name: 'Studio', defaultLocale: 'en-SA', timezone: 'UTC' }),
    },
    sequences: {
      nextNumber: (async (_r: unknown, _o: string, kind: string) => {
        counters[kind] = (counters[kind] ?? 0) + 1;
        return {
          kind,
          periodKey: '2026',
          value: counters[kind],
          number: `${kind}-${String(counters[kind])}`,
        };
      }) as never,
    },
    notifications: { insertForRecipient: vi.fn(async () => undefined) },
    audit: { record: vi.fn(async () => undefined) } as never,
    now: () => at,
    ...extra,
  });
  return { service, rows, notes, ids: [...rows.keys()] };
}

describe('52-12 e-invoice hash chain', () => {
  it('UNIT-52-19: 100 invoices + 10 credit notes chain icv 1..110 gapless, each pih the previous hash; a credited invoice keeps its icv, a voided draft takes none', async () => {
    const w = chainWorld('zatca', 100);
    for (const [i, id] of w.ids.entries()) {
      await w.service.send(context, owner, id, {}, { orgSlug: 'studio' }, false);
      if (i % 10 === 9)
        await w.service.creditNote(context, owner, id, { reason: 'Refund', full: true });
    }
    const chain = [...w.rows.values(), ...w.notes].sort((a, b) => a.zatcaIcv! - b.zatcaIcv!);
    expect(chain.map((r) => r.zatcaIcv)).toEqual(Array.from({ length: 110 }, (_, i) => i + 1));
    expect(chain[0]!.zatcaPih).toBe(GENESIS_PIH);
    for (let i = 1; i < chain.length; i += 1)
      expect(chain[i]!.zatcaPih).toBe(chain[i - 1]!.zatcaXmlHash);
    expect(chain.every((r) => r.zatcaStatus === 'ready')).toBe(true);
    expect((await w.service.get(context, owner, w.ids[9]!)).einvoice).toEqual({
      status: 'ready',
      icv: 10,
    });
    const extra = chainWorld('zatca', 1);
    const voided = await extra.service.voidInvoice(context, owner, extra.ids[0]!, {
      reason: 'Wrong client',
    });
    expect(voided.einvoice).toBeNull();
    await extra.service
      .send(context, owner, extra.ids[0]!, {}, { orgSlug: 'studio' }, false)
      .catch(() => undefined);
    expect(extra.rows.get(extra.ids[0]!)!.zatcaIcv).toBeNull();
  });

  it('leaves a non-zatca send outside the chain; the read: draft 409, eta 404, client 403', async () => {
    const eta = chainWorld('eta', 2);
    await eta.service.send(context, owner, eta.ids[0]!, {}, { orgSlug: 'studio' }, false);
    expect(eta.rows.get(eta.ids[0]!)).toMatchObject({
      zatcaIcv: null,
      zatcaPih: null,
      zatcaXmlHash: null,
      zatcaStatus: 'not_applicable',
    });
    await expect(eta.service.einvoice(context, owner, eta.ids[0]!)).rejects.toMatchObject({
      status: 404,
      details: [{ field: 'regime', message: 'einvoice_not_applicable' }],
    });
    await expect(eta.service.einvoice(context, owner, eta.ids[1]!)).rejects.toMatchObject({
      status: 409,
    });
    const client = {
      ...owner,
      kind: 'client',
      role: 'client_admin',
      clientOrganizationId: CLIENT,
    } as unknown as Principal;
    await expect(eta.service.einvoice(context, client, eta.ids[0]!)).rejects.toMatchObject({
      status: 403,
    });
  });

  it('returns the XML, a QR carrying the stored total, hashMatches true; a tampered hash is false', async () => {
    const w = chainWorld('zatca', 1);
    const id = w.ids[0]!;
    await w.service.send(context, owner, id, {}, { orgSlug: 'studio' }, false);
    const view = await w.service.einvoice(context, owner, id);
    expect(view).toMatchObject({
      regime: 'zatca',
      status: 'ready',
      icv: 1,
      pih: GENESIS_PIH,
      hashMatches: true,
    });
    expect(view.xml).toContain('<cbc:ID>invoice-1</cbc:ID>');
    expect(decodeTlv(view.qr!).find((f) => f.tag === 4)?.value).toBe('1150.00');
    w.rows.get(id)!.zatcaXmlHash = '0'.repeat(64);
    expect((await w.service.einvoice(context, owner, id)).hashMatches).toBe(false);
    const pint = chainWorld('pint_ae', 1);
    await pint.service.send(context, owner, pint.ids[0]!, {}, { orgSlug: 'studio' }, false);
    expect(await pint.service.einvoice(context, owner, pint.ids[0]!)).toMatchObject({
      regime: 'pint_ae',
      icv: null,
      qr: null,
      hashMatches: null,
    });
  });
});

/** 52-12 (R22-a) INT-52-24: a real signer over an in-memory `org_secrets` and a real FieldCipher. */
function realSigner() {
  const secrets: OrgSecretRow[] = [];
  const signer = new EinvoiceSigningService({
    database: {
      transaction: async (_c: unknown, work: (r: unknown) => unknown) => work({}),
      read: async (_c: unknown, work: (r: unknown) => unknown) => work({}),
    } as never,
    repository: {
      findActive: async () => secrets.find((r) => r.status === 'active') ?? null,
      insert: async (_r: unknown, row: OrgSecretRow) => {
        secrets.push({ ...row });
      },
      markStatus: async (_r: unknown, _o: string, id: string, status: string) => {
        secrets.find((r) => r.id === id)!.status = status;
      },
      findByFingerprint: async (_r: unknown, _o: string, _k: string, fp: string) =>
        secrets.find((r) => r.metaJson.includes(fp)) ?? null,
    } as unknown as OrgSecretsRepository,
    audit: { record: vi.fn(async () => undefined) } as never,
    cipher: createFieldCipher(
      loadFieldCipherKeyring({ FIELD_CIPHER_KEYS: `1:${randomBytes(32).toString('base64')}` }),
    ),
    sessionSecret: 'secret',
    now: () => new Date('2026-11-02T09:00:00Z'),
  });
  const key = generateKeyPairSync('ec', { namedCurve: 'secp256k1' })
    .privateKey.export({ type: 'pkcs8', format: 'pem' })
    .toString();
  const certificatePem = selfSignedCertificate({
    privateKeyPem: key,
    issuerCn: 'TManage Test CA',
    subjectCn: 'Studio',
    notBefore: new Date('2026-01-01T00:00:00Z'),
    notAfter: new Date('2027-01-01T00:00:00Z'),
  });
  return { signer, secrets, body: { certificatePem, privateKeyPem: key } };
}

describe('52-12 Phase-2 signing at send (R22-a)', () => {
  it('INT-52-24: a zatca org with a certificate sends signed; nine QR tags, tag 6 = the stored hash; the credit note is signed too', async () => {
    const { signer, body } = realSigner();
    const reauthToken = (await import('../identity/reauth-token.js')).signReauthToken(
      { userId: 'u1', sessionId: 's1', expiresAt: new Date('2026-11-02T09:01:00Z') },
      'secret',
    );
    await signer.replace(context, owner, body, { reauthToken, sessionId: 's1' });
    const w = chainWorld('zatca', 1, { signing: signer });
    const id = w.ids[0]!;
    await w.service.send(context, owner, id, {}, { orgSlug: 'studio' }, false);
    const row = w.rows.get(id)!;
    expect(row.zatcaStatus).toBe('signed');
    expect(row.zatcaCertFingerprint).toMatch(/^[0-9a-f]{64}$/u);
    const view = await w.service.einvoice(context, owner, id);
    expect(view).toMatchObject({ status: 'signed', signatureValid: true, hashMatches: true });
    const tags = decodeTlv(view.qr!);
    expect(tags.map((t) => t.tag)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(tags[5]!.value).toBe(row.zatcaXmlHash);
    expect(tags[6]!.value).toBe(row.zatcaSignature);
    await w.service.creditNote(context, owner, id, { reason: 'Refund', full: true });
    expect(w.notes[0]!.zatcaStatus).toBe('signed');
    row.zatcaSignature = `${row.zatcaSignature!.slice(0, 20)}${'A'.repeat(row.zatcaSignature!.length - 20)}`;
    expect((await w.service.einvoice(context, owner, id)).signatureValid).toBe(false);
  });

  it('a sign failure leaves the send ready and audited; the third in 24 h raises the event', async () => {
    const append = vi.fn(async () => 'e1');
    let failures = 0;
    const record = vi.fn(async () => {
      failures += 1;
    });
    const w = chainWorld('zatca', 3, {
      signing: {
        signDocument: async () => {
          throw new SigningFailure('certificate_expired');
        },
        certificateFor: async () => null,
      },
      signingStore: {
        signFailuresSince: async () =>
          record.mock.calls.filter((c) => JSON.stringify(c).includes('client_invoice.sign_failed'))
            .length,
      },
      outbox: { append },
      audit: { record } as never,
    });
    for (const id of w.ids) {
      await w.service.send(context, owner, id, {}, { orgSlug: 'studio' }, false);
      expect(w.rows.get(id)).toMatchObject({ state: 'sent', zatcaStatus: 'ready' });
    }
    expect(failures).toBeGreaterThan(0);
    expect(JSON.stringify(record.mock.calls)).toContain('certificate_expired');
    expect(append).toHaveBeenCalledTimes(1);
    expect(append.mock.calls[0]).toMatchObject([
      {},
      context,
      { type: 'finance.einvoice_sign_failed.v1', payload: { failuresIn24h: 3 } },
    ]);
  });

  it('without a certificate (none or revoked) a send is ready with five QR tags', async () => {
    const { signer } = realSigner();
    const w = chainWorld('zatca', 1, { signing: signer });
    await w.service.send(context, owner, w.ids[0]!, {}, { orgSlug: 'studio' }, false);
    const view = await w.service.einvoice(context, owner, w.ids[0]!);
    expect(view).toMatchObject({ status: 'ready', signature: null, signatureValid: null });
    expect(decodeTlv(view.qr!)).toHaveLength(5);
  });
});
