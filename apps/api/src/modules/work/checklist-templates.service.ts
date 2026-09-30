import { authorize } from '@tmanage/domain';
import type { Principal } from '@tmanage/domain';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import type {
  TenantContext,
  TenantDatabase,
  TenantQueryRunner,
} from '../../common/database/tenant-context.js';
import type { WorkChecklistTemplateRow, WorkItemRow } from '../../common/database/schema.js';
import type { WorkItemsRepository } from './work-items.repository.js';
import { WorkChecklistTemplatesRepository } from './checklist-templates.repository.js';

/**
 * x292's application service — reusable work-item checklist templates (Work module 7).
 *
 * It is `WorkLabelsService`'s shape: the repository stays free of policy, the controller stays free
 * of both, and the rules that matter live here.
 *
 * ## Two scopes, one service
 *
 * Defining, listing and deleting a template is **org-scoped** — a template belongs to the studio,
 * not to any one project — so the capability decision is an org-level `authorize()` (`projectId:
 * null`, internal audience): a caller whose role does not hold `work.update` is refused with a 403,
 * proved in the unit test without the HTTP guard. Applying a template is **item-scoped**: it names a
 * work item, so the parent is resolved tenant-scoped first and the write gate is `work.update` on
 * that item, the way the checklist's own writes are.
 *
 * ## Resolve tenant-scoped BEFORE authorizing or writing
 *
 * `delete` resolves the template scoped to the acting tenant first — a cross-tenant `templateId`
 * simply does not resolve, the same 404 an absent id gives, before `authorize()` and before any
 * write. `apply` resolves BOTH the template and the work item tenant-scoped before it authorizes: a
 * cross-tenant template or item is a 404 with no checklist row created, never a seed against
 * someone else's work.
 */

/** `work_checklist_templates.name` is `VARCHAR(120)`. */
const MAX_NAME_LENGTH = 120;
/** `work_item_checklist_items.label` is `VARCHAR(300)`; a template label seeds one. */
const MAX_LABEL_LENGTH = 300;
/** The most labels one template may carry — a bounded, well-formed JSON array. */
const MAX_LABELS = 100;

/** The client-facing projection of one checklist template. Paired in `e2e/contracts`. */
export interface ChecklistTemplateView {
  readonly id: string;
  readonly name: string;
  readonly labels: readonly string[];
  readonly createdAt: string;
}

/** The client-facing result of applying a template to a work item. Paired in `e2e/contracts`. */
export interface ApplyTemplateResultView {
  readonly workItemId: string;
  readonly templateId: string;
  readonly seeded: number;
}

export interface DefineTemplateInput {
  readonly name: string;
  readonly labels: readonly string[];
}

export class WorkChecklistTemplatesService {
  constructor(
    private readonly database: TenantDatabase,
    private readonly workItems: WorkItemsRepository,
    private readonly templates: WorkChecklistTemplatesRepository = new WorkChecklistTemplatesRepository(),
  ) {}

  /** The tenant's templates, name-ascending. Behind `work.read` at org level. */
  async list(
    context: TenantContext,
    principal: Principal,
  ): Promise<readonly ChecklistTemplateView[]> {
    this.requireOrgCapability(principal, context, 'work.read');
    return this.database.read(context, async (runner) => {
      const rows = await this.templates.list(runner, context);
      return rows.map(toView);
    });
  }

  /** Define a template. Behind `work.update` at org level. Duplicate name → 409. */
  async define(
    context: TenantContext,
    principal: Principal,
    input: DefineTemplateInput,
  ): Promise<ChecklistTemplateView> {
    this.requireOrgCapability(principal, context, 'work.update');
    const name = requiredName(input.name);
    const labels = requiredLabels(input.labels);
    return this.database.transaction(context, async (tx) => {
      const clash = await this.templates.findByName(tx, context, name);
      if (clash) {
        throw new ApiError(409, 'conflict', 'A checklist template with this name already exists');
      }
      const row = await this.templates.create(tx, context, {
        name,
        labels,
        createdBy: principal.membershipId,
      });
      return toView(row);
    });
  }

  /** Remove a template. Behind `work.update` at org level. Cross-tenant / absent → 404. */
  async delete(context: TenantContext, principal: Principal, templateId: string): Promise<void> {
    await this.database.transaction(context, async (tx) => {
      // Resolve tenant-scoped BEFORE authorizing: a cross-tenant id is a 404, no write.
      const existing = await this.templates.findById(tx, context, templateId);
      if (!existing) throw new ApiError(404, 'not_found', MESSAGES.notFound);
      this.requireOrgCapability(principal, context, 'work.update');
      await this.templates.delete(tx, context, templateId);
    });
  }

  /**
   * Apply a template to a work item, seeding its checklist. Behind `work.update` on the item.
   *
   * Both the template and the work item are resolved scoped to the acting tenant BEFORE `authorize()`
   * — a cross-tenant template or item does not resolve and is a 404 with no seed. The seed is
   * idempotent: labels already on the item's checklist are skipped, so re-applying adds nothing.
   */
  async apply(
    context: TenantContext,
    principal: Principal,
    workItemId: string,
    templateId: string,
  ): Promise<ApplyTemplateResultView> {
    return this.database.transaction(context, async (tx) => {
      // Resolve the template tenant-scoped; a cross-tenant/absent id is a 404 before any write.
      const template = await this.templates.findById(tx, context, templateId);
      if (!template) throw new ApiError(404, 'not_found', MESSAGES.notFound);

      // Resolve the parent work item tenant-scoped; a cross-tenant/absent/unreadable item is a 404.
      const parent = await this.readableParent(tx, context, principal, workItemId);
      this.requireWrite(principal, parent);

      const seeded = await this.templates.seedChecklistItems(
        tx,
        context,
        workItemId,
        template.labelsJson ?? [],
      );
      return { workItemId, templateId, seeded };
    });
  }

  /**
   * Read the parent work item, tenant-scoped, and refuse a caller who may not read it. The 404 for
   * "no relation" is produced here, before any write, and is the same 404 the work-item read
   * produces for a row that does not exist.
   */
  private async readableParent(
    runner: TenantQueryRunner,
    context: TenantContext,
    principal: Principal,
    workItemId: string,
  ): Promise<WorkItemRow> {
    const row = await this.workItems.findById(runner, context, workItemId);
    if (!row || row.deletedAt !== null || !this.mayRead(principal, row)) {
      throw new ApiError(404, 'not_found', MESSAGES.notFound);
    }
    return row;
  }

  private requireWrite(principal: Principal, parent: WorkItemRow): void {
    const verdict = authorize({
      principal,
      capability: 'work.update',
      resource: resourceOf(parent),
    });
    if (!verdict.allowed) {
      throw new ApiError(403, 'forbidden', MESSAGES.forbidden, undefined, verdict.code);
    }
  }

  private mayRead(principal: Principal, row: WorkItemRow): boolean {
    return authorize({ principal, capability: 'work.read', resource: resourceOf(row) }).allowed;
  }

  /** The org-level capability gate for the definition routes (`projectId: null`, internal). */
  private requireOrgCapability(
    principal: Principal,
    context: TenantContext,
    capability: 'work.read' | 'work.update',
  ): void {
    const verdict = authorize({
      principal,
      capability,
      resource: {
        organizationId: context.organizationId,
        projectId: null,
        audience: 'internal',
        lifecycle: 'active',
      },
    });
    if (!verdict.allowed) {
      throw new ApiError(403, 'forbidden', MESSAGES.forbidden, undefined, verdict.code);
    }
  }
}

function resourceOf(row: WorkItemRow) {
  return {
    organizationId: row.organizationId,
    projectId: row.projectId,
    audience: row.audience,
    lifecycle: row.deletedAt
      ? ('soft_deleted' as const)
      : row.state === 'archived'
        ? ('archived' as const)
        : ('active' as const),
  };
}

function toView(row: WorkChecklistTemplateRow): ChecklistTemplateView {
  return {
    id: row.id,
    name: row.name,
    labels: row.labelsJson ?? [],
    createdAt: row.createdAt.toISOString(),
  };
}

function requiredName(raw: unknown): string {
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new ApiError(400, 'validation_failed', 'The request body is invalid', [
      { field: 'name', message: 'must be a non-empty string' },
    ]);
  }
  const name = raw.trim();
  if (name.length > MAX_NAME_LENGTH) {
    throw new ApiError(400, 'validation_failed', 'The request body is invalid', [
      { field: 'name', message: `must be ${MAX_NAME_LENGTH} characters or fewer` },
    ]);
  }
  return name;
}

function requiredLabels(raw: unknown): readonly string[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new ApiError(400, 'validation_failed', 'The request body is invalid', [
      { field: 'labels', message: 'must be a non-empty array of strings' },
    ]);
  }
  if (raw.length > MAX_LABELS) {
    throw new ApiError(400, 'validation_failed', 'The request body is invalid', [
      { field: 'labels', message: `must be ${MAX_LABELS} labels or fewer` },
    ]);
  }
  const labels: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'string' || entry.trim() === '') {
      throw new ApiError(400, 'validation_failed', 'The request body is invalid', [
        { field: 'labels', message: 'each label must be a non-empty string' },
      ]);
    }
    const label = entry.trim();
    if (label.length > MAX_LABEL_LENGTH) {
      throw new ApiError(400, 'validation_failed', 'The request body is invalid', [
        { field: 'labels', message: `each label must be ${MAX_LABEL_LENGTH} characters or fewer` },
      ]);
    }
    labels.push(label);
  }
  return labels;
}
