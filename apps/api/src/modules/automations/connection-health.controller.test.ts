import { describe, expect, it } from 'vitest';
import type { Principal } from '@tmanage/domain';
import { ApiError } from '../../common/http/errors.js';
import { ConnectionHealthController } from './connection-health.controller.js';
import { ConnectionHealthService } from './connection-health.service.js';
import { IntegrationCatalogService } from './catalog.service.js';
import type { IntegrationConnectionsRepository } from './directory.repository.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { IntegrationConnectionRow } from '../../common/database/schema.js';

/**
 * Automations connection health (x220) controller proofs — database-free over fakes with the *real*
 * `authorize` and `ConnectionHealthService`. The tenant-scoped SQL round-trip is the chain's DB
 * suite; this proves the controller's own logic: the verdict from config presence, a missing-key
 * connection flagged unhealthy, a response carrying no config value, the cross-tenant `:id` 404
 * (resolve-before-authorize), and a non-`org.manage` role's 403.
 */

const ORG = 'organization-0000-0000-0000-000000000001';
const USER = 'user-0000-0000-0000-0000-000000000001';

function principal(role: Principal['role']): Principal {
  return {
    userId: USER,
    organizationId: ORG,
    kind: 'internal',
    role,
    membershipId: 'membership-0000-0000-000000000001',
    membershipStatus: 'active',
    clientOrganizationId: null,
    projectIds: [],
    hasOrgWideScope: true,
  };
}

const context = { organizationId: ORG, userId: USER } as unknown as TenantContext;

function row(overrides: Partial<IntegrationConnectionRow> = {}): IntegrationConnectionRow {
  return {
    id: 'conn-01',
    organizationId: ORG,
    appId: 'zapier',
    label: 'Ops workspace',
    status: 'connected',
    configJson: { hookPath: 'general' },
    createdBy: USER,
    createdAt: new Date('2026-09-27T10:00:00.000Z'),
    ...overrides,
  } as IntegrationConnectionRow;
}

function controllerWith(seed: readonly IntegrationConnectionRow[]) {
  const store = [...seed];
  const database = {
    read: async (_c: unknown, work: (db: unknown) => Promise<unknown>) => work({}),
  } as unknown as TenantDatabase;
  const repository = {
    list: async (_r: unknown, ctx: TenantContext) =>
      store.filter((r) => r.organizationId === ctx.organizationId),
    findById: async (_r: unknown, ctx: TenantContext, id: string) =>
      store.find((r) => r.organizationId === ctx.organizationId && r.id === id) ?? null,
  } as unknown as IntegrationConnectionsRepository;
  return new ConnectionHealthController(
    database,
    repository,
    new ConnectionHealthService(new IntegrationCatalogService()),
  );
}

describe('ConnectionHealthController', () => {
  it('computes healthy from config presence and connected status', async () => {
    const controller = controllerWith([row()]);
    const verdict = await controller.connectionHealth(context, principal('owner'), 'conn-01');
    expect(verdict.healthy).toBe(true);
    expect(verdict.issues).toEqual([]);
    expect(verdict.missingConfigKeys).toEqual([]);
  });

  it('flags a connection missing its required config key as unhealthy', async () => {
    const controller = controllerWith([row({ id: 'conn-02', configJson: { other: 'x' } })]);
    const verdict = await controller.connectionHealth(context, principal('owner'), 'conn-02');
    expect(verdict.healthy).toBe(false);
    expect(verdict.issues).toContain('missing_config');
    expect(verdict.missingConfigKeys).toEqual(['hookPath']);
  });

  it('never echoes a stored config value in the verdict', async () => {
    const secretish = 'general-super-private-value';
    const controller = controllerWith([
      row({ id: 'conn-03', configJson: { hookPath: secretish } }),
    ]);
    const verdict = await controller.connectionHealth(context, principal('owner'), 'conn-03');
    expect(JSON.stringify(verdict)).not.toContain(secretish);
  });

  it('returns 404 for a cross-tenant id (resolve before authorize)', async () => {
    const controller = controllerWith([
      row({ id: 'conn-other', organizationId: 'organization-0000-0000-0000-000000000002' }),
    ]);
    await expect(
      controller.connectionHealth(context, principal('owner'), 'conn-other'),
    ).rejects.toMatchObject({ status: 404 });
  });

  it('refuses a role without org.manage (403) for a resolvable connection', async () => {
    const controller = controllerWith([row()]);
    await expect(
      controller.connectionHealth(context, principal('workspace_admin'), 'conn-01'),
    ).rejects.toBeInstanceOf(ApiError);
    await expect(
      controller.connectionHealth(context, principal('workspace_admin'), 'conn-01'),
    ).rejects.toMatchObject({ status: 403 });
    await expect(controller.report(context, principal('workspace_admin'))).rejects.toMatchObject({
      status: 403,
    });
  });

  it('rolls up every connection for the tenant', async () => {
    const controller = controllerWith([
      row({ id: 'conn-01' }),
      row({ id: 'conn-02', appId: 'github', status: 'pending', configJson: {} }),
    ]);
    const { connections } = await controller.report(context, principal('owner'));
    expect(connections).toHaveLength(2);
    expect(connections.find((c) => c.connectionId === 'conn-02')?.healthy).toBe(false);
  });
});
