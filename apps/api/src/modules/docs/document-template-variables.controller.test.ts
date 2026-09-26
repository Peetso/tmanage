import { describe, expect, it } from 'vitest';
import type { Principal } from '@tmanage/domain';
import { ApiError } from '../../common/http/errors.js';
import {
  DocumentTemplateVariablesController,
  DocumentTemplateVariablesService,
} from './document-template-variables.controller.js';
import {
  DocumentTemplateVariableKeyConflictError,
  DocumentTemplateVariablesRepository,
} from './document-template-variables.repository.js';
import type { DocumentTemplatesRepository } from './document-templates.repository.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type {
  DocumentTemplateRow,
  DocumentTemplateVariableRow,
} from '../../common/database/schema.js';

/**
 * DOC-04 (x130) controller/service proofs over the module's fakes, with the **real** `authorize`.
 * The migration and the tenant-scoped SQL round-trip are proven separately in the DB suite (the
 * chain owns it); here the subject is the controller+service logic: the add→list→remove round-trip,
 * the duplicate-key 409, the Known-trap cross-tenant 404 (no write), and the authorize 403.
 */

const ORG = 'organization-0000-0000-0000-000000000001';
const OTHER_ORG = 'organization-0000-0000-0000-000000000002';
const TEMPLATE = 'template-0000-0000-0000-0000000000001';
const USER = 'user-0000-0000-0000-0000-000000000001';

function owner(): Principal {
  return {
    userId: USER,
    organizationId: ORG,
    kind: 'internal',
    role: 'owner',
    membershipId: 'membership-0000-0000-000000000001',
    membershipStatus: 'active',
    clientOrganizationId: null,
    projectIds: [],
    hasOrgWideScope: true,
  };
}

const context = { organizationId: ORG, userId: USER } as unknown as TenantContext;

/** A controller over an in-memory store whose template lookup is scoped to the acting tenant. */
function controllerWith(templateOrg = ORG): {
  controller: DocumentTemplateVariablesController;
  store: DocumentTemplateVariableRow[];
} {
  const store: DocumentTemplateVariableRow[] = [];
  let seq = 0;
  const database = {
    read: async (_context: unknown, work: (db: unknown) => Promise<unknown>) => work({}),
    transaction: async (_context: unknown, work: (tx: unknown) => Promise<unknown>) => work({}),
  } as unknown as TenantDatabase;

  const variables = {
    list: async (_runner: unknown, ctx: TenantContext, templateId: string) =>
      store
        .filter((row) => row.organizationId === ctx.organizationId && row.templateId === templateId)
        .sort((a, b) => a.key.localeCompare(b.key)),
    findById: async (_runner: unknown, ctx: TenantContext, templateId: string, variableId: string) =>
      store.find(
        (row) =>
          row.organizationId === ctx.organizationId &&
          row.templateId === templateId &&
          row.id === variableId,
      ) ?? null,
    create: async (
      _runner: unknown,
      ctx: TenantContext,
      input: {
        readonly templateId: string;
        readonly key: string;
        readonly label: string;
        readonly type: 'text' | 'date' | 'number';
        readonly required: boolean;
      },
    ) => {
      if (
        store.some(
          (row) =>
            row.organizationId === ctx.organizationId &&
            row.templateId === input.templateId &&
            row.key === input.key,
        )
      ) {
        throw new DocumentTemplateVariableKeyConflictError(input.key);
      }
      const row = {
        id: `dtvar-0000-0000-0000-00000000${++seq}`,
        organizationId: ctx.organizationId,
        templateId: input.templateId,
        key: input.key,
        label: input.label,
        type: input.type,
        required: input.required,
        createdAt: new Date(),
      } as DocumentTemplateVariableRow;
      store.push(row);
      return row;
    },
    deleteById: async (
      _runner: unknown,
      ctx: TenantContext,
      templateId: string,
      variableId: string,
    ) => {
      const index = store.findIndex(
        (row) =>
          row.organizationId === ctx.organizationId &&
          row.templateId === templateId &&
          row.id === variableId,
      );
      if (index < 0) return false;
      store.splice(index, 1);
      return true;
    },
  } as unknown as DocumentTemplateVariablesRepository;

  // A tenant-scoped template lookup: `TEMPLATE` exists in `templateOrg`. When that is another
  // tenant, the acting-tenant read resolves to null (what the real scoped SELECT does), which the
  // service turns into a 404 before any write — the Known trap.
  const templates = {
    findById: async (_runner: unknown, ctx: TenantContext, templateId: string) =>
      templateId === TEMPLATE && templateOrg === ctx.organizationId
        ? ({ id: TEMPLATE, organizationId: ctx.organizationId } as DocumentTemplateRow)
        : null,
  } as unknown as DocumentTemplatesRepository;

  const service = new DocumentTemplateVariablesService(database, variables, templates);
  return { controller: new DocumentTemplateVariablesController(service), store };
}

describe('DocumentTemplateVariablesController', () => {
  it('adds, lists key-ascending, then removes a variable', async () => {
    const { controller, store } = controllerWith();
    const caller = owner();

    await controller.add(context, caller, TEMPLATE, {
      key: 'client_name',
      label: 'Client name',
      type: 'text',
      required: true,
    });
    const created = await controller.add(context, caller, TEMPLATE, {
      key: 'budget',
      label: 'Budget',
      type: 'number',
      required: false,
    });

    const listed = await controller.list(context, caller, TEMPLATE);
    expect(listed.variables.map((v) => v.key)).toEqual(['budget', 'client_name']);
    // The wire projection never echoes the tenant id.
    expect(listed.variables[0]).not.toHaveProperty('organizationId');

    await controller.remove(context, caller, TEMPLATE, created.id);
    const after = await controller.list(context, caller, TEMPLATE);
    expect(after.variables.map((v) => v.key)).toEqual(['client_name']);
    expect(store).toHaveLength(1);
  });

  it('rejects a duplicate key with 409', async () => {
    const { controller, store } = controllerWith();
    const caller = owner();
    await controller.add(context, caller, TEMPLATE, {
      key: 'client_name',
      label: 'Client name',
      type: 'text',
      required: true,
    });

    const error = await controller
      .add(context, caller, TEMPLATE, {
        key: 'client_name',
        label: 'Again',
        type: 'text',
        required: false,
      })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(409);
    expect(store).toHaveLength(1);
  });

  it('reads a cross-tenant templateId as not-found (404) and writes nothing', async () => {
    // The template lives in another tenant, so the acting-tenant lookup resolves to null.
    const { controller, store } = controllerWith(OTHER_ORG);
    const error = await controller
      .add(context, owner(), TEMPLATE, {
        key: 'client_name',
        label: 'Client name',
        type: 'text',
        required: true,
      })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(404);
    expect(store).toHaveLength(0);
  });

  it('denies add to a suspended membership (403, the authorize boundary) and writes nothing', async () => {
    const { controller, store } = controllerWith();
    const suspended = { ...owner(), membershipStatus: 'suspended' as const };
    const error = await controller
      .add(context, suspended, TEMPLATE, {
        key: 'client_name',
        label: 'Client name',
        type: 'text',
        required: true,
      })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(403);
    expect(store).toHaveLength(0);
  });
});
