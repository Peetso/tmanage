import { capabilitiesFor, uuidv7 } from '@tmanage/domain';
import { describe, expect, it, vi } from 'vitest';
import type {
  TenantContext,
  TenantDatabase,
  TenantQueryRunner,
} from '../../common/database/tenant-context.js';
import type { AuditService } from '../audit/audit.service.js';
import type { MembershipsRepository } from './memberships.repository.js';
import type { OrganizationsRepository } from './organizations.repository.js';
import { ProvisioningService } from './provisioning.service.js';
import type { WorkspacesRepository } from './workspaces.repository.js';

describe('ProvisioningService.provisionFounderWithin', () => {
  it('provisions inside the caller-owned runner and audits the first-owner origin', async () => {
    const transaction = vi.fn();
    const database = { transaction } as unknown as TenantDatabase;
    const record = vi.fn();
    const audit = { record } as unknown as AuditService;

    const calls: string[] = [];
    const organizations = {
      create: vi.fn(
        async (
          _tx: unknown,
          _ctx: TenantContext,
          input: { id: string; slug: string; name: string },
        ) => {
          calls.push('organization');
          return { id: input.id, slug: input.slug, name: input.name };
        },
      ),
    } as unknown as OrganizationsRepository;
    const workspaces = {
      create: vi.fn(async () => {
        calls.push('workspace');
        return { id: 'workspace-1' };
      }),
    } as unknown as WorkspacesRepository;
    const createFounder = vi.fn(
      async (_tx: unknown, _ctx: TenantContext, input: { id: string; role: string }) => {
        calls.push('membership');
        return { id: input.id, role: input.role };
      },
    );
    const memberships = { createFounder } as unknown as MembershipsRepository;

    const userId = uuidv7();
    const runner = {} as TenantQueryRunner;
    const runnerFor = vi.fn((_context: TenantContext) => runner);

    const service = new ProvisioningService(
      database,
      audit,
      organizations,
      workspaces,
      memberships,
    );
    const result = await service.provisionFounderWithin(runnerFor, {
      userId,
      slug: 'acme',
      name: 'Acme',
      defaultLocale: 'en',
      timezone: 'UTC',
      correlationId: uuidv7(),
      origin: 'first_owner_setup',
    });

    expect(transaction).not.toHaveBeenCalled();
    expect(runnerFor).toHaveBeenCalledTimes(1);
    const context = runnerFor.mock.calls[0]![0];
    expect(context.organizationId).toBe(result.organizationId);
    expect([...context.capabilities].sort()).toEqual([...capabilitiesFor('owner')].sort());
    expect(calls).toEqual(['organization', 'workspace', 'membership']);
    expect(createFounder.mock.calls[0]![0]).toBe(runner);
    expect(createFounder.mock.calls[0]![2]).toMatchObject({ userId, role: 'owner' });
    expect(result.role).toBe('owner');
    expect(record).toHaveBeenCalledTimes(1);
    expect(record.mock.calls[0]![2]).toMatchObject({
      action: 'organization.provisioned',
      metadata: { origin: 'first_owner_setup', workspace_id: 'workspace-1' },
    });
  });
});
