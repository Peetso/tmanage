import { authorize } from '@tmanage/domain';
import type { Principal } from '@tmanage/domain';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import type {
  TenantContext,
  TenantDatabase,
  TenantQueryRunner,
} from '../../common/database/tenant-context.js';
import type { WorkItemLabelRow, WorkItemRow } from '../../common/database/schema.js';
import { WORK_LABEL_COLORS } from '../../common/database/schema.js';
import type { WorkItemsRepository } from './work-items.repository.js';
import { WorkLabelsRepository } from './work-labels.repository.js';

/**
 * x233's application service — work item labels / tags (Work module 7).
 *
 * Two objects, one table (see `0105_work_item_labels.sql`): a **label definition** the studio owns,
 * and a **label assignment** tying a definition to a work item. The two rules that matter live here,
 * the way `WorkChecklistService` places them:
 *
 * ## Resolve the item AND the label, tenant-scoped, BEFORE authorizing or writing
 *
 * Assign and remove name a `workItemId` in the path; the parent work item is read first, scoped to
 * the acting tenant — a cross-tenant `work_item_id` simply does not resolve, and the answer is the
 * same 404 an absent id gives, before `authorize()` is ever asked and before any write. The label id
 * is resolved the same way: a label of another studio does not resolve and is a 404.
 *
 * ## Definitions are org-scoped; assignments inherit the item's audience
 *
 * Defining and listing labels is org-wide (behind `work.update` to define, `work.read` to list). A
 * name is unique per tenant — a collision is a 409. `color` must come from the fixed palette
 * `WORK_LABEL_COLORS`; anything else is a 400. Tagging is idempotent: assigning a label already on
 * the item returns the existing assignment rather than a duplicate.
 */

/** The client-facing projection of one label definition. Paired in `e2e/contracts`. */
export interface WorkLabelView {
  readonly id: string;
  readonly name: string;
  readonly color: string;
  readonly createdAt: string;
}

/** The client-facing projection of one label assigned to a work item. Paired in `e2e/contracts`. */
export interface ItemLabelView {
  readonly id: string;
  readonly workItemId: string;
  readonly labelId: string;
  readonly name: string;
  readonly color: string;
  readonly createdAt: string;
}

export interface DefineLabelInput {
  readonly name: string;
  readonly color: string;
}

export class WorkLabelsService {
  constructor(
    private readonly database: TenantDatabase,
    private readonly workItems: WorkItemsRepository,
    private readonly labels: WorkLabelsRepository = new WorkLabelsRepository(),
  ) {}

  /** The tenant's label definitions, name-ascending. Behind `work.read`. */
  async listDefinitions(context: TenantContext): Promise<readonly WorkLabelView[]> {
    return this.database.read(context, async (runner) => {
      const rows = await this.labels.listDefinitions(runner, context);
      return rows.map(toLabelView);
    });
  }

  /** Define a label. Behind `work.update`. Duplicate name → 409, bad color → 400. */
  async define(context: TenantContext, input: DefineLabelInput): Promise<WorkLabelView> {
    const name = requiredName(input.name);
    const color = requiredColor(input.color);
    return this.database.transaction(context, async (tx) => {
      const clash = await this.labels.findDefinitionByName(tx, context, name);
      if (clash) {
        throw new ApiError(409, 'conflict', 'A label with this name already exists');
      }
      const row = await this.labels.createDefinition(tx, context, { name, color });
      return toLabelView(row);
    });
  }

  /** The labels assigned to a work item. Behind `work.read` on the parent item. */
  async listForItem(
    context: TenantContext,
    principal: Principal,
    workItemId: string,
  ): Promise<readonly ItemLabelView[]> {
    return this.database.read(context, async (runner) => {
      await this.readableParent(runner, context, principal, workItemId);
      const [assignments, definitions] = await Promise.all([
        this.labels.listAssignments(runner, context, workItemId),
        this.labels.listDefinitions(runner, context),
      ]);
      const byId = new Map(definitions.map((row) => [row.id, row]));
      return assignments
        .map((assignment) => toItemLabelView(assignment, byId.get(assignment.labelId ?? '')))
        .filter((view): view is ItemLabelView => view !== null);
    });
  }

  /** Tag a work item with a label. Behind `work.update`. Idempotent; unknown label → 404. */
  async assign(
    context: TenantContext,
    principal: Principal,
    workItemId: string,
    labelId: string,
  ): Promise<ItemLabelView> {
    return this.database.transaction(context, async (tx) => {
      const parent = await this.readableParent(tx, context, principal, workItemId);
      this.requireWrite(principal, parent);

      // The label is resolved scoped to the tenant; a cross-tenant or unknown label id does not
      // resolve and is a 404, before any write.
      const definition = await this.labels.findDefinition(tx, context, labelId);
      if (!definition) throw new ApiError(404, 'not_found', MESSAGES.notFound);

      // Idempotent: an already-present tag returns its existing row rather than a duplicate.
      const existing = await this.labels.findAssignment(tx, context, workItemId, labelId);
      const row =
        existing ?? (await this.labels.createAssignment(tx, context, workItemId, labelId));
      const view = toItemLabelView(row, definition);
      if (!view) throw new ApiError(404, 'not_found', MESSAGES.notFound);
      return view;
    });
  }

  /** Untag a work item. Behind `work.update`. A tag that is not present is a no-op 204. */
  async remove(
    context: TenantContext,
    principal: Principal,
    workItemId: string,
    labelId: string,
  ): Promise<void> {
    await this.database.transaction(context, async (tx) => {
      const parent = await this.readableParent(tx, context, principal, workItemId);
      this.requireWrite(principal, parent);
      await this.labels.deleteAssignment(tx, context, workItemId, labelId);
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

function toLabelView(row: WorkItemLabelRow): WorkLabelView {
  return {
    id: row.id,
    name: row.name ?? '',
    color: row.color ?? '',
    createdAt: row.createdAt.toISOString(),
  };
}

/** An assignment row plus its definition; `null` if the definition is missing (never, in practice). */
function toItemLabelView(
  assignment: WorkItemLabelRow,
  definition: WorkItemLabelRow | undefined,
): ItemLabelView | null {
  if (!definition || assignment.workItemId === null || assignment.labelId === null) return null;
  return {
    id: assignment.id,
    workItemId: assignment.workItemId,
    labelId: assignment.labelId,
    name: definition.name ?? '',
    color: definition.color ?? '',
    createdAt: assignment.createdAt.toISOString(),
  };
}

function requiredName(raw: unknown): string {
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new ApiError(400, 'validation_failed', 'The request body is invalid', [
      { field: 'name', message: 'must be a non-empty string' },
    ]);
  }
  const name = raw.trim();
  if (name.length > 120) {
    throw new ApiError(400, 'validation_failed', 'The request body is invalid', [
      { field: 'name', message: 'must be 120 characters or fewer' },
    ]);
  }
  return name;
}

function requiredColor(raw: unknown): string {
  if (typeof raw !== 'string' || !(WORK_LABEL_COLORS as readonly string[]).includes(raw)) {
    throw new ApiError(400, 'validation_failed', 'The request body is invalid', [
      { field: 'color', message: `must be one of: ${WORK_LABEL_COLORS.join(', ')}` },
    ]);
  }
  return raw;
}
