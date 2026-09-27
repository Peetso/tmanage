import { describe, expect, it } from 'vitest';
import type { Principal } from '@tmanage/domain';
import { ApiError } from '../../common/http/errors.js';
import { IntegrationDirectoryController } from './directory.controller.js';
import { IntegrationCatalogService } from './catalog.service.js';
import type { IntegrationConnectionsRepository } from './directory.repository.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { IntegrationConnectionRow } from '../../common/database/schema.js';

/**
 * Automations app directory (x165) controller proofs — database-free over fakes with the *real*
 * `authorize`. The migration and the tenant-scoped SQL round-trip are the chain's DB suite, not here;
 * this file proves the controller's own logic: the org-scoped `org.manage` decision, catalog merged
 * with connections, the off-catalog 404 with no write, the secret-shaped-key 400 with no write, and
 * a non-`org.manage` role's 403.
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

/** A controller over an in-memory store. `createCalls` records every insert so a test asserts none. */
function controllerWith(seed: readonly IntegrationConnectionRow[] = []) {
  const store: IntegrationConnectionRow[] = [...seed];
  const createCalls: { appId: string; label: string }[] = [];
  let seq = store.length;

  const database = {
    read: async (_c: unknown, work: (db: unknown) => Promise<unknown>) => work({}),
    transaction: async (_c: unknown, work: (tx: unknown) => Promise<unknown>) => work({}),
  } as unknown as TenantDatabase;

  const repository = {
    list: async (_runner: unknown, ctx: TenantContext) =>
      store.filter((row) => row.organizationId === ctx.organizationId),
    create: async (
      _runner: unknown,
      ctx: TenantContext,
      input: {
        appId: string;
        label: string;
        status: 'connected' | 'pending';
        config: Record<string, string | number | boolean>;
        createdBy: string;
      },
    ) => {
      createCalls.push({ appId: input.appId, label: input.label });
      const row: IntegrationConnectionRow = {
        id: `conn-${(seq += 1).toString().padStart(2, '0')}`,
        organizationId: ctx.organizationId,
        appId: input.appId,
        label: input.label,
        status: input.status,
        configJson: input.config,
        createdBy: input.createdBy,
        createdAt: new Date('2026-09-27T10:00:00.000Z'),
      };
      store.push(row);
      return row;
    },
  } as unknown as IntegrationConnectionsRepository;

  return {
    controller: new IntegrationDirectoryController(
      database,
      new IntegrationCatalogService(),
      repository,
    ),
    createCalls,
  };
}

describe('IntegrationDirectoryController', () => {
  it('returns the catalog with the org connections merged onto each app', async () => {
    const seed: IntegrationConnectionRow = {
      id: 'conn-seed',
      organizationId: ORG,
      appId: 'slack',
      label: 'Ops workspace',
      status: 'connected',
      configJson: { channel: 'general' },
      createdBy: USER,
      createdAt: new Date('2026-09-27T10:00:00.000Z'),
    };
    const { controller } = controllerWith([seed]);

    const { apps } = await controller.directory(context, principal('owner'));
    const slack = apps.find((app) => app.id === 'slack');
    expect(slack?.connections).toHaveLength(1);
    expect(slack?.connections[0]?.label).toBe('Ops workspace');
    expect(slack?.connections[0]).not.toHaveProperty('organizationId');
    // Apps with no connection are still listed, with an empty list.
    expect(apps.find((app) => app.id === 'github')?.connections).toEqual([]);
  });

  it('creates a connection against a catalog app and echoes no organization id', async () => {
    const { controller, createCalls } = controllerWith();
    const created = await controller.connect(context, principal('owner'), 'github', {
      label: 'Main repo',
      config: { repo: 'peetso/tmanage' },
    });
    expect(created.appId).toBe('github');
    expect(created.status).toBe('pending');
    expect(created).not.toHaveProperty('organizationId');
    expect(createCalls).toEqual([{ appId: 'github', label: 'Main repo' }]);
  });

  it('returns 404 for an off-catalog appId and writes nothing', async () => {
    const { controller, createCalls } = controllerWith();
    await expect(
      controller.connect(context, principal('owner'), 'not-a-real-app', { label: 'x' }),
    ).rejects.toMatchObject({ status: 404 });
    expect(createCalls).toEqual([]);
  });

  it('rejects a secret-shaped config key with 400 and writes nothing', async () => {
    const { controller, createCalls } = controllerWith();
    await expect(
      controller.connect(context, principal('owner'), 'slack', {
        label: 'Ops',
        config: { api_token: 'xoxb-should-never-persist' },
      }),
    ).rejects.toMatchObject({ status: 400 });
    expect(createCalls).toEqual([]);
  });

  it('refuses a role without org.manage (403)', async () => {
    const { controller, createCalls } = controllerWith();
    // `org_admin` holds nearly every capability but explicitly not `org.manage` (capabilities ceiling),
    // so the org-scoped authorize denies both the read and the write with a 403.
    await expect(controller.directory(context, principal('org_admin'))).rejects.toBeInstanceOf(
      ApiError,
    );
    await expect(controller.directory(context, principal('org_admin'))).rejects.toMatchObject({
      status: 403,
    });
    await expect(
      controller.connect(context, principal('org_admin'), 'slack', { label: 'Ops' }),
    ).rejects.toMatchObject({ status: 403 });
    expect(createCalls).toEqual([]);
  });
});
