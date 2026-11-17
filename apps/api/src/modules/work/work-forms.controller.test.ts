import { describe, expect, it } from 'vitest';
import type { Principal } from '@tmanage/domain';
import { ApiError } from '../../common/http/errors.js';
import { WorkFormsController } from './work-forms.controller.js';
import type { WorkFormsRepository } from './work-forms.repository.js';
import type { WorkItemsService, WorkItemView } from './work-items.service.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { WorkFormRow } from '../../common/database/schema.js';

/**
 * WORK intake forms (x146) controller proofs, database-free over fakes with the *real* `authorize`.
 * The migration and the tenant-scoped SQL round-trip are the chain's DB suite, not here; this file
 * proves the controller's own logic: the org-scoped authorize decision, define→list→submit creating
 * a work item, the invalid-payload 400 with no work item, and the Known-trap 404 for a cross-tenant
 * form id with no write.
 */

const ORG = 'organization-0000-0000-0000-000000000001';
const OTHER_ORG = 'organization-0000-0000-0000-000000000002';
const PROJECT = 'project-0000-0000-0000-0000-000000000001';
const USER = 'user-0000-0000-0000-0000-000000000001';
/** 52-20 (0258): the public columns of a form that was never published. */
const NOT_PUBLIC = {
  publicSlug: null,
  publicEnabled: false,
  publishedAt: null,
  attachmentProjectId: null,
  updatedAt: null,
};

function principal(role: Principal['role']): Principal {
  return {
    userId: USER,
    organizationId: ORG,
    kind: 'internal',
    role,
    membershipId: 'membership-0000-0000-000000000001',
    membershipStatus: 'active',
    clientOrganizationId: null,
    projectIds: [PROJECT],
    hasOrgWideScope: true,
  };
}

const context = { organizationId: ORG, userId: USER } as unknown as TenantContext;

function workItemView(id: string, title: string): WorkItemView {
  return {
    id,
    projectId: PROJECT,
    type: 'task',
    title,
    state: 'backlog',
    ownerUserId: null,
    audience: 'internal',
    startAt: null,
    dueAt: null,
    completedAt: null,
    version: 1,
    createdAt: '2026-09-26T10:00:00.000Z',
    updatedAt: '2026-09-26T10:00:00.000Z',
    deletedAt: null,
  };
}

/**
 * A controller over an in-memory store. `createCalls` records every work-item create so a test can
 * assert none happened. The fake repository is tenant-scoped like the real one: a row of another org
 * resolves to null through `findById`.
 */
function controllerWith(seed: readonly WorkFormRow[] = []) {
  const store: WorkFormRow[] = [...seed];
  const createCalls: {
    projectId: string;
    title: string;
    description?: string | null | undefined;
  }[] = [];
  let seq = store.length;

  const database = {
    read: async (_context: unknown, work: (db: unknown) => Promise<unknown>) => work({}),
    transaction: async (_context: unknown, work: (tx: unknown) => Promise<unknown>) => work({}),
  } as unknown as TenantDatabase;

  const repository = {
    list: async (_runner: unknown, _ctx: unknown) =>
      [...store].sort((a, b) => a.name.localeCompare(b.name)),
    findById: async (_runner: unknown, ctx: TenantContext, formId: string) =>
      store.find((row) => row.id === formId && row.organizationId === ctx.organizationId) ?? null,
    create: async (
      _runner: unknown,
      ctx: TenantContext,
      input: { name: string; fields: WorkFormRow['fieldsJson']; createdBy: string },
    ) => {
      const row: WorkFormRow = {
        id: `work-form-${(seq += 1).toString().padStart(2, '0')}`,
        organizationId: ctx.organizationId,
        name: input.name,
        fieldsJson: input.fields,
        createdBy: input.createdBy,
        createdAt: new Date('2026-09-26T10:00:00.000Z'),
        ...NOT_PUBLIC,
      };
      store.push(row);
      return row;
    },
  } as unknown as WorkFormsRepository;

  const workItems = {
    create: async (
      _ctx: TenantContext,
      _principal: Principal,
      input: { projectId: string; title: string; description?: string | null },
    ) => {
      createCalls.push({
        projectId: input.projectId,
        title: input.title,
        description: input.description,
      });
      return workItemView(`work-item-${createCalls.length}`, input.title);
    },
  } as unknown as WorkItemsService;

  return {
    controller: new WorkFormsController(database, repository, workItems),
    store,
    createCalls,
  };
}

describe('WorkFormsController', () => {
  it('defines a form, lists it, and a submission creates a work item', async () => {
    const { controller, createCalls } = controllerWith();
    const actor = principal('owner');

    const created = await controller.create(context, actor, {
      name: 'New client request',
      fields: [
        { label: 'Summary', type: 'text', required: true },
        { label: 'Budget', type: 'number', required: false },
      ],
    });
    expect(created.name).toBe('New client request');
    expect(created.fields).toHaveLength(2);
    expect(created).not.toHaveProperty('organizationId');
    // 2026-10-31 live-test fix: the screen needs the public-link state to show Share / Copy.
    expect(created).toMatchObject({ published: false, publicSlug: null });
    // 52-20a: the team view carries the owner's attachment project (none yet).
    expect(created).toHaveProperty('attachmentProjectId', null);

    const listed = await controller.list(context, actor);
    expect(listed.forms.map((form) => form.id)).toContain(created.id);

    const workItem = await controller.submit(context, actor, created.id, {
      projectId: PROJECT,
      title: 'Handle the request',
      values: { Summary: 'A new brief', Budget: 1000 },
    });
    expect(workItem.id).toBe('work-item-1');
    // 2026-10-31 live-test fix: the answers are kept on the created work item.
    expect(createCalls).toEqual([
      {
        projectId: PROJECT,
        title: 'Handle the request',
        description: 'Summary: A new brief\nBudget: 1000',
      },
    ]);
  });

  it('leaves blank optional answers out and stores no description when nothing was answered', async () => {
    const { controller, createCalls } = controllerWith();
    const actor = principal('owner');
    const form = await controller.create(context, actor, {
      name: 'Optional only',
      fields: [
        { label: 'Notes', type: 'text', required: false },
        { label: 'Urgent', type: 'checkbox', required: false },
      ],
    });

    await controller.submit(context, actor, form.id, {
      projectId: PROJECT,
      title: 'Nothing answered',
      values: { Notes: '  ' },
    });
    await controller.submit(context, actor, form.id, {
      projectId: PROJECT,
      title: 'Urgent one',
      values: { Notes: '', Urgent: true },
    });
    expect(createCalls.map((call) => call.description)).toEqual([null, 'Urgent: Yes']);
  });

  it('rejects an invalid payload with 400 and creates no work item', async () => {
    const { controller, createCalls } = controllerWith();
    const actor = principal('owner');
    const form = await controller.create(context, actor, {
      name: 'Intake',
      fields: [{ label: 'Summary', type: 'text', required: true }],
    });

    await expect(
      controller.submit(context, actor, form.id, {
        projectId: PROJECT,
        title: 'No summary given',
        values: {},
      }),
    ).rejects.toMatchObject({ status: 400 });
    expect(createCalls).toEqual([]);
  });

  it('returns 404 for a cross-tenant form id and writes nothing', async () => {
    const foreignForm: WorkFormRow = {
      id: 'work-form-foreign',
      organizationId: OTHER_ORG,
      name: 'Another studio form',
      fieldsJson: [{ label: 'Summary', type: 'text', required: true }],
      createdBy: 'user-0000-0000-0000-0000-0000000000ff',
      createdAt: new Date('2026-09-26T10:00:00.000Z'),
      ...NOT_PUBLIC,
    };
    const { controller, createCalls } = controllerWith([foreignForm]);

    await expect(
      controller.submit(context, principal('owner'), foreignForm.id, {
        projectId: PROJECT,
        title: 'Cross-tenant attempt',
        values: { Summary: 'x' },
      }),
    ).rejects.toBeInstanceOf(ApiError);
    await expect(
      controller.submit(context, principal('owner'), foreignForm.id, {
        projectId: PROJECT,
        title: 'Cross-tenant attempt',
        values: { Summary: 'x' },
      }),
    ).rejects.toMatchObject({ status: 404 });
    expect(createCalls).toEqual([]);
  });

  it('refuses to define a form without work.create (403)', async () => {
    const { controller } = controllerWith();
    // `guest` holds work.read but not work.create (capabilities ceiling), so the org-scoped
    // authorize denies the define with a 403.
    await expect(
      controller.create(context, principal('guest'), {
        name: 'Intake',
        fields: [{ label: 'Summary', type: 'text', required: true }],
      }),
    ).rejects.toMatchObject({ status: 403 });
  });
});
