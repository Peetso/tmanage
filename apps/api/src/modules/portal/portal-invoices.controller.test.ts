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

function controller(): { controller: PortalInvoicesController; update: ReturnType<typeof vi.fn> } {
  const update = vi.fn(async () => undefined);
  const repository = {
    findInvoice: async () => ({
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
    }),
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
  } as unknown as ClientInvoicesRepository;
  const run = async (_c: unknown, work: (r: unknown) => unknown) => work({});
  const service = new ClientInvoicesService({
    database: { transaction: run, read: run } as never,
    repository,
    finance: {} as never,
    sequences: {} as never,
    notifications: {} as never,
    audit: {} as never,
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
