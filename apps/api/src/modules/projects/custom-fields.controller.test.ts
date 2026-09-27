import { describe, expect, it } from 'vitest';
import type { Principal } from '@tmanage/domain';
import {
  ProjectCustomFieldDefinitionsController,
  ProjectCustomFieldValuesController,
} from './custom-fields.controller.js';
import { ProjectCustomFieldsService } from './custom-fields.service.js';
import type { ProjectCustomFieldsRepository } from './custom-fields.repository.js';
import type { ProjectsRepository } from './projects.repository.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { ProjectCustomFieldRow, ProjectRow } from '../../common/database/schema.js';

/**
 * PROJ / module 8 (x310). The project custom-fields controllers over the module's fakes with the
 * **real** `authorize()` evaluator. The migration and the tenant-scoped SQL round-trip are proven in
 * the DB suites (out of this build's scope); here the subject is the two refusals the brief requires —
 * a define without `org.manage` is a 403 that writes nothing, and setting a value on a project that is
 * not the caller's tenant is a 404 that writes nothing — plus the define → set → read happy path that
 * makes those refusals meaningful.
 */

const ORG = 'organization-0000-0000-0000-000000000001';
const USER = 'user-0000-0000-0000-0000-000000000001';
const PROJECT = 'project-0000-0000-0000-0000-00000000001';

function principal(role: Principal['role'], orgWide = false): Principal {
  return {
    userId: USER,
    organizationId: ORG,
    kind: 'internal',
    role,
    membershipId: 'membership-0000-0000-000000000001',
    membershipStatus: 'active',
    clientOrganizationId: null,
    projectIds: [PROJECT],
    hasOrgWideScope: orgWide,
  };
}

const owner = principal('owner', true);
/** A member holds `work.read` but neither `org.manage` nor `project.manage`. */
const member = principal('member');
const context = { organizationId: ORG, userId: USER } as unknown as TenantContext;

function build(): {
  definitions: ProjectCustomFieldDefinitionsController;
  values: ProjectCustomFieldValuesController;
  store: ProjectCustomFieldRow[];
} {
  const store: ProjectCustomFieldRow[] = [];
  const database = {
    read: async (_c: unknown, work: (db: unknown) => Promise<unknown>) => work({}),
    transaction: async (_c: unknown, work: (tx: unknown) => Promise<unknown>) => work({}),
  } as unknown as TenantDatabase;

  const repository = {
    listDefinitions: async (_r: unknown, ctx: TenantContext) =>
      store.filter(
        (row) => row.organizationId === ctx.organizationId && row.rowKind === 'definition',
      ),
    findDefinition: async (_r: unknown, ctx: TenantContext, key: string) =>
      store.find(
        (row) =>
          row.organizationId === ctx.organizationId &&
          row.rowKind === 'definition' &&
          row.fieldKey === key,
      ) ?? null,
    listValues: async (_r: unknown, ctx: TenantContext, projectId: string) =>
      store.filter(
        (row) =>
          row.organizationId === ctx.organizationId &&
          row.rowKind === 'value' &&
          row.projectId === projectId,
      ),
    createDefinition: async (
      _r: unknown,
      ctx: TenantContext,
      input: { fieldKey: string; name: string; fieldType: string; options?: readonly string[] },
    ) => {
      const row = {
        id: `field-${input.fieldKey}`,
        organizationId: ctx.organizationId,
        rowKind: 'definition',
        projectId: '',
        fieldKey: input.fieldKey,
        name: input.name,
        fieldType: input.fieldType,
        optionsJson: input.options ?? null,
        valueText: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      } as unknown as ProjectCustomFieldRow;
      store.push(row);
      return row;
    },
    deleteDefinition: async (_r: unknown, _c: TenantContext, _k: string) => undefined,
    setValue: async (
      _r: unknown,
      ctx: TenantContext,
      input: { projectId: string; fieldKey: string; valueText: string },
    ) => {
      const row = {
        id: `value-${input.projectId}-${input.fieldKey}`,
        organizationId: ctx.organizationId,
        rowKind: 'value',
        projectId: input.projectId,
        fieldKey: input.fieldKey,
        name: null,
        fieldType: null,
        optionsJson: null,
        valueText: input.valueText,
        createdAt: new Date(),
        updatedAt: new Date(),
      } as unknown as ProjectCustomFieldRow;
      store.push(row);
      return row;
    },
  } as unknown as ProjectCustomFieldsRepository;

  // Only the acting tenant's own project resolves; a project in another tenant is invisible.
  const projects = {
    findById: async (_r: unknown, ctx: TenantContext, id: string) =>
      id === PROJECT && ctx.organizationId === ORG
        ? ({ id: PROJECT, organizationId: ORG } as unknown as ProjectRow)
        : null,
  } as unknown as ProjectsRepository;

  const service = new ProjectCustomFieldsService(database, repository, projects);
  return {
    definitions: new ProjectCustomFieldDefinitionsController(service),
    values: new ProjectCustomFieldValuesController(service),
    store,
  };
}

describe('ProjectCustomFields — capability and tenant refusals', () => {
  it('defines a field, sets a value, and reads the resolved map (happy path)', async () => {
    const { definitions, values } = build();
    const def = await definitions.define(context, owner, {
      key: 'client_tier',
      name: 'Client tier',
      type: 'text',
    });
    expect(def.fieldKey).toBe('client_tier');
    expect((def as unknown as Record<string, unknown>)['organizationId']).toBeUndefined();

    await values.set(context, owner, PROJECT, 'client_tier', { value: 'gold' });
    const map = await values.list(context, owner, PROJECT);
    expect(map.fields).toEqual([
      {
        fieldKey: 'client_tier',
        name: 'Client tier',
        fieldType: 'text',
        options: [],
        value: 'gold',
      },
    ]);
  });

  it('refuses a define without org.manage with a 403 and writes nothing', async () => {
    const { definitions, store } = build();
    await expect(
      definitions.define(context, member, { key: 'secret', name: 'Secret', type: 'text' }),
    ).rejects.toEqual(expect.objectContaining({ status: 403, code: 'forbidden' }));
    expect(store).toHaveLength(0);
  });

  it("refuses setting a value on another tenant's project id with a 404 and writes nothing", async () => {
    const { definitions, values, store } = build();
    await definitions.define(context, owner, {
      key: 'client_tier',
      name: 'Client tier',
      type: 'text',
    });
    const before = store.length;
    await expect(
      values.set(context, owner, 'project-in-another-tenant', 'client_tier', { value: 'gold' }),
    ).rejects.toEqual(expect.objectContaining({ status: 404, code: 'not_found' }));
    expect(store).toHaveLength(before);
  });
});
