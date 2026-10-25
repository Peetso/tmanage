import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import type { Principal } from '@tmanage/domain';
import { OrganizationsController } from './organizations.controller.js';
import type { OrganizationProfileRepository } from './organization-profile.repository.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { ProvisioningService } from './provisioning.service.js';
import type { OrganizationDirectoryRepository } from './organization-directory.repository.js';
import type { AddressAvailabilityRepository } from './address-availability.repository.js';
import type { AuditService } from '../audit/audit.service.js';

/** A11 — renaming the company and changing its logo each leave an audit row. */

const ORG = '00000000-0000-4000-8000-0000000000a1';
const USER = '00000000-0000-4000-8000-0000000000c1';
const context = { organizationId: ORG } as unknown as TenantContext;
const owner: Principal = {
  userId: USER,
  organizationId: ORG,
  kind: 'internal',
  role: 'owner',
  membershipId: '00000000-0000-4000-8000-0000000000e1',
  membershipStatus: 'active',
  clientOrganizationId: null,
  projectIds: [],
  hasOrgWideScope: true,
};

function setup() {
  let row = { name: 'Harbour Studio', logoFileId: null as string | null };
  const profile = {
    find: async () => row,
    rename: async (_r: unknown, _c: unknown, name: string) => {
      row = { ...row, name };
    },
    setLogo: async (_r: unknown, _c: unknown, logoFileId: string | null) => {
      row = { ...row, logoFileId };
    },
    findLogoAsset: async (_r: unknown, _c: unknown, id: string) => ({
      id,
      purpose: 'org_logo',
      status: 'clean',
    }),
  };
  const database = {
    read: async (_c: unknown, work: (db: unknown) => Promise<unknown>) => work({}),
    transaction: async (_c: unknown, work: (tx: unknown) => Promise<unknown>) => work({}),
  } as unknown as TenantDatabase;
  const audit = { record: vi.fn(async () => ({})) };
  const controller = new OrganizationsController(
    {} as ProvisioningService,
    {} as OrganizationDirectoryRepository,
    database,
    {} as AddressAvailabilityRepository,
    profile as unknown as OrganizationProfileRepository,
    audit as unknown as AuditService,
  );
  return { controller, audit };
}

describe('OrganizationsController — audit of name and logo changes', () => {
  it('records organization.renamed, with no names in the metadata', async () => {
    const { controller, audit } = setup();
    await controller.rename(context, owner, { name: 'Harbour & Co' });
    expect(audit.record).toHaveBeenCalledWith(expect.anything(), context, {
      action: 'organization.renamed',
      objectId: ORG,
      result: 'allowed',
      actorUserId: USER,
      metadata: {},
    });
  });

  it('records organization.logo_changed when the logo is set and when it is removed', async () => {
    const { controller, audit } = setup();
    await controller.setLogo(context, owner, { fileId: 'file-1' });
    await controller.removeLogo(context, owner);
    const calls = audit.record.mock.calls.map((call) => (call as unknown[])[2]);
    expect(calls).toEqual([
      expect.objectContaining({ action: 'organization.logo_changed', metadata: { change: 'set' } }),
      expect.objectContaining({
        action: 'organization.logo_changed',
        metadata: { change: 'removed' },
      }),
    ]);
  });

  it('writes no audit row when the rename is refused', async () => {
    const { controller, audit } = setup();
    await expect(controller.rename(context, owner, { name: '   ' })).rejects.toMatchObject({
      status: 400,
    });
    expect(audit.record).not.toHaveBeenCalled();
  });
});
