import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import type { Principal } from '@tmanage/domain';
import { OrganizationsController } from './organizations.controller.js';
import type {
  LogoAssetRow,
  OrganizationProfileRepository,
  OrganizationProfileRow,
} from './organization-profile.repository.js';
import { ApiError } from '../../common/http/errors.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { ProvisioningService } from './provisioning.service.js';
import type { OrganizationDirectoryRepository } from './organization-directory.repository.js';
import type { AddressAvailabilityRepository } from './address-availability.repository.js';

/**
 * A11 — the Organization card's name and logo routes over fakes, with the real `authorize`.
 */

const ORG = '00000000-0000-4000-8000-0000000000a1';

function principal(role: Principal['role']): Principal {
  return {
    userId: '00000000-0000-4000-8000-0000000000c1',
    organizationId: ORG,
    kind: 'internal',
    role,
    membershipId: '00000000-0000-4000-8000-0000000000e1',
    membershipStatus: 'active',
    clientOrganizationId: null,
    projectIds: [],
    hasOrgWideScope: true,
  };
}

const context = { organizationId: ORG } as unknown as TenantContext;

class FakeProfile {
  row: OrganizationProfileRow = { name: 'Harbour Studio', logoFileId: null };
  assets = new Map<string, LogoAssetRow>();
  writes = 0;

  find(): Promise<OrganizationProfileRow | undefined> {
    return Promise.resolve(this.row);
  }
  rename(_r: unknown, _c: unknown, name: string): Promise<void> {
    this.writes += 1;
    this.row = { ...this.row, name };
    return Promise.resolve();
  }
  setLogo(_r: unknown, _c: unknown, logoFileId: string | null): Promise<void> {
    this.writes += 1;
    this.row = { ...this.row, logoFileId };
    return Promise.resolve();
  }
  findLogoAsset(_r: unknown, _c: unknown, id: string): Promise<LogoAssetRow | undefined> {
    return Promise.resolve(this.assets.get(id));
  }
}

function controllerWith(profile: FakeProfile): OrganizationsController {
  const database = {
    read: async (_c: unknown, work: (db: unknown) => Promise<unknown>) => work({}),
    transaction: async (_c: unknown, work: (tx: unknown) => Promise<unknown>) => work({}),
  } as unknown as TenantDatabase;
  return new OrganizationsController(
    {} as ProvisioningService,
    {} as OrganizationDirectoryRepository,
    database,
    {} as AddressAvailabilityRepository,
    profile as unknown as OrganizationProfileRepository,
  );
}

async function statusOf(promise: Promise<unknown>): Promise<number | undefined> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  return error instanceof ApiError ? error.status : undefined;
}

describe('OrganizationsController — A11 name and logo', () => {
  it('PATCH renames the organization (trimmed) and answers the new profile', async () => {
    const profile = new FakeProfile();
    const view = await controllerWith(profile).rename(context, principal('owner'), {
      name: '  Northstar Studio ',
    });
    expect(view).toEqual({ name: 'Northstar Studio', logoFileId: null });
  });

  it('PATCH refuses an empty name with 400 and writes nothing', async () => {
    const profile = new FakeProfile();
    expect(
      await statusOf(controllerWith(profile).rename(context, principal('owner'), { name: ' ' })),
    ).toBe(400);
    expect(profile.writes).toBe(0);
  });

  it('PATCH refuses a role without org.manage with 403', async () => {
    const profile = new FakeProfile();
    expect(
      await statusOf(
        controllerWith(profile).rename(context, principal('manager'), { name: 'Other' }),
      ),
    ).toBe(403);
    expect(profile.writes).toBe(0);
  });

  it('PUT logo accepts an org_logo upload and DELETE clears it', async () => {
    const profile = new FakeProfile();
    profile.assets.set('file-1', { id: 'file-1', purpose: 'org_logo', status: 'uploaded' });
    const controller = controllerWith(profile);
    expect(await controller.setLogo(context, principal('owner'), { fileId: 'file-1' })).toEqual({
      name: 'Harbour Studio',
      logoFileId: 'file-1',
    });
    expect(await controller.removeLogo(context, principal('owner'))).toEqual({
      name: 'Harbour Studio',
      logoFileId: null,
    });
  });

  it('PUT logo refuses another purpose (400) and an unknown file (404)', async () => {
    const profile = new FakeProfile();
    profile.assets.set('file-2', { id: 'file-2', purpose: 'deliverable', status: 'ready' });
    const controller = controllerWith(profile);
    expect(
      await statusOf(controller.setLogo(context, principal('owner'), { fileId: 'file-2' })),
    ).toBe(400);
    expect(
      await statusOf(controller.setLogo(context, principal('owner'), { fileId: 'nope' })),
    ).toBe(404);
    expect(profile.writes).toBe(0);
  });
});
