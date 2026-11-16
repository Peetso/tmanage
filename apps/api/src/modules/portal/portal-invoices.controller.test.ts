import { describe, expect, it, vi } from 'vitest';
import type { Principal } from '@tmanage/domain';
import type { TenantContext } from '../../common/database/tenant-context.js';
import type { ClientInvoicesRepository } from '../finance/client-invoices.repository.js';
import { ClientInvoicesService } from '../finance/client-invoices.service.js';
import { PortalInvoicesController } from './portal-invoices.controller.js';

/** AUTH-52-10 / 52-11 — the client invoice projection: its keys only; another client is 404. */

const ORG = 'organization-0000-0000-0000-000000000001';
const context = { organizationId: ORG, userId: 'client-user-1' } as unknown as TenantContext;
const client = (clientOrganizationId: string, role = 'client_admin'): Principal => ({
  userId: 'client-user-1',
  organizationId: ORG,
  kind: 'client',
  role: role as Principal['role'],
  membershipId: 'membership-client-1',
  membershipStatus: 'active',
  clientOrganizationId,
  projectIds: ['p1'],
  hasOrgWideScope: false,
});

function controller(row: Record<string, unknown> = {}): {
  controller: PortalInvoicesController;
  update: ReturnType<typeof vi.fn>;
} {
  const update = vi.fn(async () => undefined);
  const invoice = {
    id: 'i1',
    clientOrganizationId: 'acme',
    number: 'INV-2026-0001',
    kind: 'standard',
    language: 'en',
    state: 'sent',
    documentLabel: 'invoice',
    issueDate: '2026-11-01',
    dueDate: '2026-11-16',
    currency: 'SAR',
    subtotalMinor: 30_000,
    discountMinor: 0,
    taxMinor: 4_500,
    totalMinor: 34_500,
    paidMinor: 0,
    depositAppliedMinor: 0,
    notesText: 'Thank you',
    internalNote: 'margin is thin',
    viewedAt: null,
    termsText: null,
    contentHash: null,
    taxRegistrationRef: null,
    createdAt: new Date('2026-11-01T08:00:00Z'),
    updatedAt: new Date('2026-11-01T08:00:00Z'),
    ...row,
  };
  const repository = {
    findInvoice: async () => invoice,
    // The repository is asked for the principal's client only; the service checks again.
    listInvoices: async () => [invoice, { ...invoice, id: 'i2', clientOrganizationId: 'globex' }],
    updateInvoice: update,
    insertEvent: async () => undefined,
    setting: async () => undefined,
    lines: async () => [
      {
        descriptionEn: 'Design — Sara',
        descriptionAr: 'تصميم — سارة',
        quantityCenti: 150,
        unit: 'hour',
        unitPriceMinor: 20_000,
        taxBp: 1500,
        lineNetMinor: 30_000,
        lineGrossMinor: 34_500,
        groupKey: 'person:m9',
      },
    ],
    payments: async () => [],
    creditNotes: async () => [],
    clientBilling: async () => null,
  } as unknown as ClientInvoicesRepository;
  const run = async (_c: unknown, work: (r: unknown) => unknown) => work({});
  const service = new ClientInvoicesService({
    database: { transaction: run, read: run } as never,
    repository,
    finance: {
      organization: async () => ({
        name: 'Northstar',
        defaultLocale: 'en-EG',
        timezone: 'Africa/Cairo',
      }),
      profile: async () => null,
    } as never,
    sequences: {} as never,
    notifications: {} as never,
    audit: {} as never,
    // 23:30 UTC on the 18th is already the 19th in Cairo: three days past a due date of the 16th.
    now: () => new Date('2026-11-18T23:30:00Z'),
  });
  return { controller: new PortalInvoicesController(service), update };
}

describe('AUTH-52-10/11 portal invoice projection', () => {
  it('returns only the projection keys, names nobody, and stamps viewed once', async () => {
    const { controller: c, update } = controller();
    const body = await c.get(context, client('acme'), 'i1', undefined, undefined);
    expect(body.lines[0]).toEqual({
      description: 'Professional services',
      quantity: 1.5,
      unit: 'hour',
      unitPriceMinor: 20_000,
      taxBp: 1500,
      netMinor: 30_000,
      grossMinor: 34_500,
    });
    expect(JSON.stringify(body)).not.toMatch(/internal|margin|cost|member|Sara|person:/iu);
    expect(update).toHaveBeenCalledTimes(1);
  });

  it("is a 404 for another client's invoice and for a client viewer", async () => {
    const { controller: c } = controller();
    await expect(
      c.get(context, client('globex'), 'i1', undefined, undefined),
    ).rejects.toMatchObject({
      status: 404,
    });
    await expect(
      c.get(context, client('acme', 'client_viewer'), 'i1', undefined, undefined),
    ).rejects.toMatchObject({ status: 404 });
  });
});

/** 52-28 — the header carries the label (client language) and the notice; never the rule or VAT status. */
describe('52-28 portal invoice label and notice', () => {
  it('shows the proforma label and the notice that went out, without the rule text', async () => {
    const { controller: c } = controller({
      language: 'ar',
      documentLabel: 'proforma',
      taxNoticeShown: true,
      taxRegistrationRef: null,
    });
    const body = await c.get(context, client('acme'), 'i1', undefined, undefined);
    expect(body).toMatchObject({
      documentLabel: 'proforma',
      documentLabelText: 'فاتورة مبدئية',
      taxRegistrationRef: null,
    });
    expect(body.taxNotice).toContain('ليست فاتورة ضريبية');
    expect(JSON.stringify(body)).not.toMatch(/vat|regime|registration_status|zatca"|requires/iu);
  });

  it('drops the notice once the invoice is a tax invoice', async () => {
    const { controller: c } = controller({
      documentLabel: 'tax_invoice',
      taxNoticeShown: true,
      taxRegistrationRef: 'ABCDEFGHJK0123456789ABCDEF',
    });
    const body = await c.get(context, client('acme'), 'i1', undefined, undefined);
    expect(body).toMatchObject({ documentLabelText: 'Tax invoice', taxNotice: null });
  });
});

/** 52-13 — the Money page: where an invoice stands, and the client's own print document. */
describe('52-13 portal invoice standing and print', () => {
  it('works out overdue days on the workspace calendar, and paid when nothing is left', async () => {
    const { controller: c } = controller();
    const body = await c.get(context, client('acme'), 'i1', undefined, undefined);
    expect(body.standing).toEqual({ kind: 'overdue', days: 3 });
    const { controller: paid } = controller({ paidMinor: 34_500, state: 'paid' });
    const settled = await paid.get(context, client('acme'), 'i1', undefined, undefined);
    expect(settled.standing).toEqual({ kind: 'paid' });
  });

  it('prints the client their own invoice with safe headers, naming nobody', async () => {
    const { controller: c } = controller();
    const headers = new Map<string, string>();
    const reply = { header: (name: string, value: string) => headers.set(name, value) };
    const file = await c.print(context, client('acme'), 'i1', 'en', reply);
    const html = await new Response(file.getStream() as unknown as ReadableStream).text();
    expect(html).toContain('INV-2026-0001');
    expect(html).toContain('Professional services');
    expect(html).not.toMatch(/Sara|margin is thin/u);
    expect(headers.get('content-security-policy')).toBe(
      "default-src 'none'; style-src 'unsafe-inline'",
    );
    expect(headers.get('cache-control')).toBe('private, no-store');
    expect(headers.get('x-content-type-options')).toBe('nosniff');
  });

  it("lists only the signed-in client's own invoices, with where each stands", async () => {
    const { controller: c } = controller();
    const { invoices } = await c.list(context, client('acme'));
    expect(invoices.map((i) => i.id)).toEqual(['i1']);
    expect(invoices[0]?.standing).toEqual({ kind: 'overdue', days: 3 });
    expect(JSON.stringify(invoices)).not.toMatch(/internal|margin|cost/iu);
  });

  it("refuses another client's invoice, a client viewer and a draft with the same 404", async () => {
    const reply = { header: () => undefined };
    await expect(
      controller().controller.print(context, client('globex'), 'i1', 'en', reply),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      controller().controller.print(context, client('acme', 'client_viewer'), 'i1', 'en', reply),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      controller({ state: 'draft' }).controller.print(context, client('acme'), 'i1', 'en', reply),
    ).rejects.toMatchObject({ status: 404 });
  });
});
