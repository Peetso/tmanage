import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import type { TenantDatabase } from '../../common/database/tenant-context.js';
import type { OrganizationDirectoryRepository } from './organization-directory.repository.js';
import { OrganizationsController } from './organizations.controller.js';
import type { ProvisioningService } from './provisioning.service.js';

/**
 * H1 — the organization switcher names a custom role and carries its set, so the browser shows a
 * custom-role member the Control pages their role opens. Built-in, client and suspended rows are
 * left exactly as they were and cost no extra read.
 */

const ROLE_ID = '0192a8f0-0000-7000-8000-00000000c0de';

function row(organizationId: string, role: string, extra: Record<string, unknown> = {}) {
  return {
    organizationId,
    slug: organizationId,
    name: organizationId,
    audience: 'internal' as const,
    role,
    clientOrganizationName: null,
    suspended: false,
    ...extra,
  };
}

describe('GET /v1/organizations — custom roles', () => {
  it('adds roleName and capabilities to a custom-role row only', async () => {
    const rows = [
      row('org-a', ROLE_ID),
      row('org-b', 'owner'),
      row('org-c', ROLE_ID, { suspended: true }),
      row('org-d', 'client_admin', { audience: 'client', clientOrganizationName: 'Acme' }),
    ];
    const controller = new OrganizationsController(
      {} as ProvisioningService,
      { listForUser: async () => rows } as unknown as OrganizationDirectoryRepository,
      {} as TenantDatabase,
    );
    const lookup = vi
      .spyOn(
        OrganizationsController.prototype as unknown as {
          customRoleOf: (...args: unknown[]) => Promise<unknown>;
        },
        'customRoleOf',
      )
      .mockResolvedValue({ name: 'Night editor', capabilities: ['org.manage'] });

    const view = await controller.list({ userId: 'user-1' } as never, { headers: {} } as never);

    expect(view.organizations[0]).toMatchObject({
      role: ROLE_ID,
      roleName: 'Night editor',
      capabilities: ['org.manage'],
    });
    for (const other of view.organizations.slice(1)) {
      expect(other).not.toHaveProperty('roleName');
      expect(other).not.toHaveProperty('capabilities');
    }
    expect(lookup).toHaveBeenCalledTimes(1);
    lookup.mockRestore();
  });

  it('leaves the row without a hint when the role cannot be resolved', async () => {
    const controller = new OrganizationsController(
      {} as ProvisioningService,
      {
        listForUser: async () => [row('org-a', ROLE_ID)],
      } as unknown as OrganizationDirectoryRepository,
      // No real database: the resolver fails, and the row still lists.
      {} as TenantDatabase,
    );
    const view = await controller.list({ userId: 'user-1' } as never, { headers: {} } as never);
    expect(view.organizations).toHaveLength(1);
    expect(view.organizations[0]).not.toHaveProperty('roleName');
  });
});
