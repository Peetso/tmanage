import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import type { TenantDatabase } from '../../common/database/tenant-context.js';
import type { AddressAvailabilityRepository } from './address-availability.repository.js';
import type { OrganizationDirectoryRepository } from './organization-directory.repository.js';
import { OrganizationsController } from './organizations.controller.js';
import type { ProvisioningService } from './provisioning.service.js';

/** ON-02's live "available" tick: the create route's rules first, then one boolean read. */
function controllerWith(taken: boolean) {
  const isTaken = vi.fn(async () => taken);
  const controller = new OrganizationsController(
    {} as ProvisioningService,
    {} as OrganizationDirectoryRepository,
    {} as TenantDatabase,
    { isTaken } as unknown as AddressAvailabilityRepository,
  );
  const request = { headers: {} };
  return { controller, isTaken, request };
}

describe('GET /v1/organizations/address-availability', () => {
  it('answers available for a free, well-formed address', async () => {
    const { controller, isTaken, request } = controllerWith(false);
    const view = await controller.addressAvailability('northstar', request as never);
    expect(view).toEqual({ slug: 'northstar', available: true, reason: null, message: null });
    expect(isTaken).toHaveBeenCalledWith({ slug: 'northstar', correlationId: expect.any(String) });
  });

  it('answers taken when an organization holds it', async () => {
    const { controller, request } = controllerWith(true);
    const view = await controller.addressAvailability('northstar', request as never);
    expect(view).toMatchObject({ available: false, reason: 'taken' });
  });

  it('refuses reserved and malformed addresses without reading the table', async () => {
    const { controller, isTaken, request } = controllerWith(false);
    expect(await controller.addressAvailability('admin', request as never)).toMatchObject({
      available: false,
      reason: 'invalid',
    });
    expect(await controller.addressAvailability('Bad Slug', request as never)).toMatchObject({
      available: false,
      reason: 'invalid',
    });
    expect(isTaken).not.toHaveBeenCalled();
  });
});
