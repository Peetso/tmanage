import { describe, expect, it } from 'vitest';
import type { Principal } from '@tmanage/domain';
import { AutomationTemplateTagsController } from './template-tags.controller.js';
import { AutomationTemplateTagsService } from './template-tags.service.js';
import type { AutomationTemplateTagsRepository } from './template-tags.repository.js';
import type { WorkflowTemplatesRepository } from './templates.repository.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type {
  AutomationTemplateTagRow,
  WorkflowTemplateRow,
} from '../../common/database/schema.js';

/**
 * Automation template-tag (x335) proofs, database-free over fakes with the *real* `authorize`. The
 * migration and the tenant-scoped SQL round-trip are the chain's DB suite, not here; this file proves
 * the controller's own security logic — resolve-before-authorize (cross-tenant/unknown template id →
 * 404 with no write), the org-scoped `org.manage` decision (403 with no write), the label validation
 * (empty → 400), the duplicate (409), the succeeded add writing exactly one row, the idempotent delete,
 * and the tenant-scoped filter.
 */

const ORG = 'organization-0000-0000-0000-000000000001';
const OTHER_ORG = 'organization-0000-0000-0000-000000000002';
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

function template(overrides: Partial<WorkflowTemplateRow> = {}): WorkflowTemplateRow {
  return {
    id: 'workflow-template-01',
    organizationId: ORG,
    name: 'Notify owner on new work',
    triggerKind: 'work_item_created',
    actionKind: 'notify_owner',
    configJson: {},
    enabled: true,
    createdBy: USER,
    createdAt: new Date('2026-09-27T10:00:00.000Z'),
    ...overrides,
  };
}

function harness(templates: readonly WorkflowTemplateRow[]) {
  const store: AutomationTemplateTagRow[] = [];
  let seq = 0;

  const database = {
    read: async (_c: unknown, work: (db: unknown) => Promise<unknown>) => work({}),
    transaction: async (_c: unknown, work: (tx: unknown) => Promise<unknown>) => work({}),
  } as unknown as TenantDatabase;

  const templatesRepository = {
    findById: async (_r: unknown, ctx: TenantContext, id: string) =>
      templates.find((row) => row.organizationId === ctx.organizationId && row.id === id) ?? null,
  } as unknown as WorkflowTemplatesRepository;

  const tagsRepository = {
    listForTemplate: async (_r: unknown, ctx: TenantContext, templateId: string) =>
      store.filter(
        (t) => t.organizationId === ctx.organizationId && t.workflowTemplateId === templateId,
      ),
    findByLabel: async (_r: unknown, ctx: TenantContext, templateId: string, label: string) =>
      store.find(
        (t) =>
          t.organizationId === ctx.organizationId &&
          t.workflowTemplateId === templateId &&
          t.label.toLowerCase() === label.toLowerCase(),
      ) ?? null,
    create: async (
      _r: unknown,
      ctx: TenantContext,
      input: { templateId: string; label: string; createdBy: string },
    ) => {
      const row: AutomationTemplateTagRow = {
        id: `automation-template-tag-${(seq += 1).toString().padStart(2, '0')}`,
        organizationId: ctx.organizationId,
        workflowTemplateId: input.templateId,
        label: input.label,
        createdBy: input.createdBy,
        createdAt: new Date('2026-09-27T11:00:00.000Z'),
      };
      store.push(row);
      return row;
    },
    deleteForTemplate: async (
      _r: unknown,
      ctx: TenantContext,
      templateId: string,
      tagId: string,
    ) => {
      const before = store.length;
      for (let i = store.length - 1; i >= 0; i -= 1) {
        const t = store[i]!;
        if (
          t.organizationId === ctx.organizationId &&
          t.workflowTemplateId === templateId &&
          t.id === tagId
        )
          store.splice(i, 1);
      }
      return store.length < before;
    },
    listTemplatesByTag: async (_r: unknown, ctx: TenantContext, label: string) => {
      const ids = new Set(
        store
          .filter(
            (t) =>
              t.organizationId === ctx.organizationId &&
              t.label.toLowerCase() === label.toLowerCase(),
          )
          .map((t) => t.workflowTemplateId),
      );
      return templates.filter(
        (tpl) => tpl.organizationId === ctx.organizationId && ids.has(tpl.id),
      );
    },
  } as unknown as AutomationTemplateTagsRepository;

  const service = new AutomationTemplateTagsService(database, tagsRepository);
  const controller = new AutomationTemplateTagsController(database, templatesRepository, service);
  return { controller, store };
}

describe('AutomationTemplateTagsController', () => {
  it('adds a tag and returns it without the tenant id', async () => {
    const { controller, store } = harness([template()]);
    const view = await controller.add(context, principal('owner'), 'workflow-template-01', {
      label: '  urgent  review ',
    });
    expect(view).toMatchObject({ templateId: 'workflow-template-01', label: 'urgent review' });
    expect(view).not.toHaveProperty('organizationId');
    expect(store).toHaveLength(1);
  });

  it('rejects an empty label with 400 and writes nothing', async () => {
    const { controller, store } = harness([template()]);
    await expect(
      controller.add(context, principal('owner'), 'workflow-template-01', { label: '   ' }),
    ).rejects.toMatchObject({ status: 400, auditCode: 'automation_template_tag_label_empty' });
    expect(store).toHaveLength(0);
  });

  it('returns 404 with no write for a cross-tenant template id', async () => {
    const { controller, store } = harness([
      template({ id: 'workflow-template-other', organizationId: OTHER_ORG }),
    ]);
    await expect(
      controller.add(context, principal('owner'), 'workflow-template-other', { label: 'x' }),
    ).rejects.toMatchObject({ status: 404 });
    expect(store).toHaveLength(0);
  });

  it('refuses a role without org.manage with 403 and writes nothing', async () => {
    // workspace_admin does not hold `org.manage`, so it is denied here.
    const { controller, store } = harness([template()]);
    await expect(
      controller.add(context, principal('workspace_admin'), 'workflow-template-01', { label: 'x' }),
    ).rejects.toMatchObject({ status: 403 });
    expect(store).toHaveLength(0);
  });

  it('rejects a duplicate label (case-insensitively) with 409 and no second write', async () => {
    const { controller, store } = harness([template()]);
    await controller.add(context, principal('owner'), 'workflow-template-01', { label: 'Urgent' });
    await expect(
      controller.add(context, principal('owner'), 'workflow-template-01', { label: 'urgent' }),
    ).rejects.toMatchObject({ status: 409, auditCode: 'automation_template_tag_duplicate' });
    expect(store).toHaveLength(1);
  });

  it('removes a tag idempotently', async () => {
    const { controller, store } = harness([template()]);
    const tag = await controller.add(context, principal('owner'), 'workflow-template-01', {
      label: 'keep',
    });
    await expect(
      controller.remove(context, principal('owner'), 'workflow-template-01', tag.id),
    ).resolves.toBeUndefined();
    expect(store).toHaveLength(0);
    // A second delete of the now-absent tag is still a no-op, not a 404.
    await expect(
      controller.remove(context, principal('owner'), 'workflow-template-01', tag.id),
    ).resolves.toBeUndefined();
  });

  it('filters the org templates by tag', async () => {
    const other = template({ id: 'workflow-template-02', name: 'Digest weekly' });
    const { controller } = harness([template(), other]);
    await controller.add(context, principal('owner'), 'workflow-template-02', { label: 'weekly' });
    const result = await controller.filter(context, principal('owner'), 'weekly');
    expect(result.templates).toEqual([{ id: 'workflow-template-02', name: 'Digest weekly' }]);
  });
});
