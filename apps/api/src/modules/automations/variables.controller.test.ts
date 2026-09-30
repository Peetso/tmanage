import { describe, expect, it } from 'vitest';
import type { Principal } from '@tmanage/domain';
import { AutomationVariablesController } from './variables.controller.js';
import type { AutomationVariablesRepository } from './variables.repository.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { AutomationVariableRow } from '../../common/database/schema.js';

/**
 * Automation-variables (x305) proofs, database-free over a fake repository with the *real* `authorize`.
 * The migration and the tenant-scoped SQL round-trip are the chain's DB suite, not here; this file
 * proves the controller's own security logic: the org-scoped `org.manage` decision (403 with no
 * write), the secret-like/malformed key refusal (400 with no write), a succeeding upsert writing
 * exactly one row without leaking the id or tenant, and the idempotent delete.
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

function controllerWith() {
  const store: AutomationVariableRow[] = [];

  const database = {
    read: async (_context: unknown, work: (db: unknown) => Promise<unknown>) => work({}),
    transaction: async (_context: unknown, work: (tx: unknown) => Promise<unknown>) => work({}),
  } as unknown as TenantDatabase;

  const variablesRepository = {
    list: async (_runner: unknown, ctx: TenantContext) =>
      store.filter((r) => r.organizationId === ctx.organizationId),
    upsert: async (
      _runner: unknown,
      ctx: TenantContext,
      input: { varKey: string; varValue: string; updatedBy: string },
    ) => {
      const existing = store.find(
        (r) => r.organizationId === ctx.organizationId && r.varKey === input.varKey,
      );
      if (existing) {
        existing.varValue = input.varValue;
        existing.updatedBy = input.updatedBy;
        return existing;
      }
      const row: AutomationVariableRow = {
        id: `automation-variable-${(store.length + 1).toString().padStart(2, '0')}`,
        organizationId: ctx.organizationId,
        varKey: input.varKey,
        varValue: input.varValue,
        updatedBy: input.updatedBy,
        updatedAt: new Date('2026-09-27T11:00:00.000Z'),
      };
      store.push(row);
      return row;
    },
    remove: async (_runner: unknown, ctx: TenantContext, varKey: string) => {
      const index = store.findIndex(
        (r) => r.organizationId === ctx.organizationId && r.varKey === varKey,
      );
      if (index >= 0) store.splice(index, 1);
    },
  } as unknown as AutomationVariablesRepository;

  const controller = new AutomationVariablesController(database, variablesRepository);
  return { controller, store };
}

describe('AutomationVariablesController', () => {
  it('upserts a variable and returns it without the id or tenant', async () => {
    const { controller, store } = controllerWith();
    const view = await controller.upsert(context, principal('owner'), 'deploy_channel', {
      value: '#releases',
    });

    expect(view).toEqual({
      key: 'deploy_channel',
      value: '#releases',
      updatedBy: USER,
      updatedAt: '2026-09-27T11:00:00.000Z',
    });
    expect(view).not.toHaveProperty('id');
    expect(view).not.toHaveProperty('organizationId');
    expect(store).toHaveLength(1);

    // A second PUT of the same key replaces in place, not a second row.
    await controller.upsert(context, principal('owner'), 'deploy_channel', { value: '#ops' });
    expect(store).toHaveLength(1);
    expect(store[0]?.varValue).toBe('#ops');
  });

  it('rejects a secret-like key with 400 and writes nothing', async () => {
    const { controller, store } = controllerWith();
    await expect(
      controller.upsert(context, principal('owner'), 'apiToken', { value: 'anything' }),
    ).rejects.toMatchObject({ status: 400, auditCode: 'automation_variable_key_secret_like' });
    expect(store).toHaveLength(0);
  });

  it('rejects a malformed key with 400 and writes nothing', async () => {
    const { controller, store } = controllerWith();
    await expect(
      controller.upsert(context, principal('owner'), '1bad-key', { value: 'x' }),
    ).rejects.toMatchObject({ status: 400, auditCode: 'automation_variable_key_invalid' });
    expect(store).toHaveLength(0);
  });

  it('refuses a role without org.manage with 403 and writes nothing', async () => {
    // org_admin holds every capability except `org.manage`, so it is denied here.
    const { controller, store } = controllerWith();
    await expect(
      controller.upsert(context, principal('org_admin'), 'deploy_channel', { value: '#releases' }),
    ).rejects.toMatchObject({ status: 403 });
    expect(store).toHaveLength(0);
  });

  it('deletes idempotently — a 204 whether or not the key existed', async () => {
    const { controller, store } = controllerWith();
    await controller.upsert(context, principal('owner'), 'deploy_channel', { value: '#releases' });
    await expect(
      controller.remove(context, principal('owner'), 'deploy_channel'),
    ).resolves.toBeUndefined();
    expect(store).toHaveLength(0);
    // Deleting an absent key is not an error.
    await expect(
      controller.remove(context, principal('owner'), 'deploy_channel'),
    ).resolves.toBeUndefined();
  });
});
