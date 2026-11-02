import { describe, expect, it } from 'vitest';
import type { Principal } from '@tmanage/domain';
import type { EinvoiceChainCheckRow } from '../../common/database/schema.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import { EinvoiceChainController } from './einvoice-chain.controller.js';
import type { EinvoiceChainRepository } from './einvoice-chain.repository.js';

/** 52-12 (R22-b) — the chain verdict route: no row → never_checked, a client principal → 403. */

const ORG = '00000000-0000-7000-8000-000000000001';
const context = { organizationId: ORG, userId: 'u1' } as TenantContext;
const principal = (kind: 'internal' | 'client'): Principal =>
  ({
    userId: 'u1',
    organizationId: ORG,
    kind,
    role: kind === 'internal' ? 'owner' : 'client_viewer',
    membershipId: 'm1',
    membershipStatus: 'active',
    clientOrganizationId: kind === 'client' ? 'c1' : null,
    projectIds: [],
    hasOrgWideScope: kind === 'internal',
  }) as unknown as Principal;

const database = {
  read: (_context: TenantContext, work: (runner: unknown) => Promise<unknown>) => work({}),
} as unknown as TenantDatabase;
const repo = (row: EinvoiceChainCheckRow | null) =>
  ({ latest: () => Promise.resolve(row) }) as unknown as EinvoiceChainRepository;

describe('GET …/finance/einvoicing/chain', () => {
  it('reads never_checked with no row, the verdict with one, and refuses a client', async () => {
    await expect(
      new EinvoiceChainController(database, repo(null)).chain(context, principal('internal')),
    ).resolves.toEqual({ status: 'never_checked' });

    const row = {
      id: 'x',
      organizationId: ORG,
      checkedAt: new Date('2026-11-02T03:00:00Z'),
      status: 'broken',
      headIcv: 110,
      documents: 110,
      breakIcv: 51,
      breakReason: 'pih_mismatch',
      detailJson: '{}',
    } as EinvoiceChainCheckRow;
    await expect(
      new EinvoiceChainController(database, repo(row)).chain(context, principal('internal')),
    ).resolves.toEqual({
      status: 'broken',
      checkedAt: '2026-11-02T03:00:00.000Z',
      headIcv: 110,
      documents: 110,
      breakIcv: 51,
      breakReason: 'pih_mismatch',
    });

    await expect(
      new EinvoiceChainController(database, repo(row)).chain(context, principal('client')),
    ).rejects.toMatchObject({ status: 403 });
  });
});
