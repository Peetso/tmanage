import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import { uuidv7 } from '@tmanage/domain';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import { workItemLabels } from '../../common/database/schema.js';
import type { WorkItemLabelRow } from '../../common/database/schema.js';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';

/**
 * Work item labels — x233's storage half (Work module 7).
 *
 * One table serves two row kinds (see `0105_work_item_labels.sql`): a **definition** row carries
 * `name` + `color` with `work_item_id`/`label_id` NULL; an **assignment** row carries
 * `work_item_id` + `label_id` with `name`/`color` NULL. Every read and write is bound to
 * `(organization_id, …)`, so a caller in the wrong tenant sees nothing rather than a leak, and the
 * repository holds no policy — the service decides who may read or write, and the composite foreign
 * keys of migration 0105 make a cross-tenant item or label id a non-existent pair.
 */

/** The largest label page a single read returns; mirrors the bounded reads elsewhere. */
export const MAX_LABELS_PAGE = 500;

export interface CreateLabelDefinitionInput {
  readonly name: string;
  readonly color: string;
}

export class WorkLabelsRepository {
  /** The tenant's label definitions, name-ascending, bounded to one page. */
  async listDefinitions(
    runner: TenantQueryRunner,
    context: TenantContext,
    limit: number = MAX_LABELS_PAGE,
  ): Promise<readonly WorkItemLabelRow[]> {
    return tenantDrizzle(runner)
      .select()
      .from(workItemLabels)
      .where(
        and(
          eq(workItemLabels.organizationId, context.organizationId),
          isNull(workItemLabels.workItemId),
        ),
      )
      .orderBy(asc(workItemLabels.name), asc(workItemLabels.id))
      .limit(Math.min(Math.max(1, Math.trunc(limit)), MAX_LABELS_PAGE));
  }

  /** One label definition, scoped to the tenant; `null` if absent (or if the id names an assignment). */
  async findDefinition(
    runner: TenantQueryRunner,
    context: TenantContext,
    labelId: string,
  ): Promise<WorkItemLabelRow | null> {
    const rows = await tenantDrizzle(runner)
      .select()
      .from(workItemLabels)
      .where(
        and(
          eq(workItemLabels.organizationId, context.organizationId),
          eq(workItemLabels.id, labelId),
          isNull(workItemLabels.workItemId),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  /** A definition with this name in the tenant; `null` if the name is free. */
  async findDefinitionByName(
    runner: TenantQueryRunner,
    context: TenantContext,
    name: string,
  ): Promise<WorkItemLabelRow | null> {
    const rows = await tenantDrizzle(runner)
      .select()
      .from(workItemLabels)
      .where(
        and(
          eq(workItemLabels.organizationId, context.organizationId),
          eq(workItemLabels.name, name),
          isNull(workItemLabels.workItemId),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  /** Define a label. Definition rows carry `name` + `color` and NULL `work_item_id`/`label_id`. */
  async createDefinition(
    runner: TenantQueryRunner,
    context: TenantContext,
    input: CreateLabelDefinitionInput,
  ): Promise<WorkItemLabelRow> {
    const id = uuidv7();
    await tenantDrizzle(runner)
      .insert(workItemLabels)
      .values({
        id,
        organizationId: context.organizationId,
        workItemId: null,
        labelId: null,
        name: input.name,
        color: input.color,
        createdAt: sql`current_timestamp(3)`,
      });

    const created = await this.findDefinition(runner, context, id);
    if (!created) {
      // Unreachable: the insert above committed this row in this transaction.
      throw new Error('label definition vanished immediately after insert');
    }
    return created;
  }

  /** The assignment rows for one work item of this tenant. */
  async listAssignments(
    runner: TenantQueryRunner,
    context: TenantContext,
    workItemId: string,
    limit: number = MAX_LABELS_PAGE,
  ): Promise<readonly WorkItemLabelRow[]> {
    return tenantDrizzle(runner)
      .select()
      .from(workItemLabels)
      .where(
        and(
          eq(workItemLabels.organizationId, context.organizationId),
          eq(workItemLabels.workItemId, workItemId),
        ),
      )
      .orderBy(asc(workItemLabels.id))
      .limit(Math.min(Math.max(1, Math.trunc(limit)), MAX_LABELS_PAGE));
  }

  /** One assignment of a label to a work item, scoped to the tenant; `null` if not tagged. */
  async findAssignment(
    runner: TenantQueryRunner,
    context: TenantContext,
    workItemId: string,
    labelId: string,
  ): Promise<WorkItemLabelRow | null> {
    const rows = await tenantDrizzle(runner)
      .select()
      .from(workItemLabels)
      .where(
        and(
          eq(workItemLabels.organizationId, context.organizationId),
          eq(workItemLabels.workItemId, workItemId),
          eq(workItemLabels.labelId, labelId),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  /** Tag a work item with a label. Assignment rows carry `work_item_id` + `label_id`. */
  async createAssignment(
    runner: TenantQueryRunner,
    context: TenantContext,
    workItemId: string,
    labelId: string,
  ): Promise<WorkItemLabelRow> {
    const id = uuidv7();
    await tenantDrizzle(runner)
      .insert(workItemLabels)
      .values({
        id,
        organizationId: context.organizationId,
        workItemId,
        labelId,
        name: null,
        color: null,
        createdAt: sql`current_timestamp(3)`,
      });

    const created = await this.findAssignment(runner, context, workItemId, labelId);
    if (!created) {
      // Unreachable: the insert above committed this row in this transaction.
      throw new Error('label assignment vanished immediately after insert');
    }
    return created;
  }

  /** Untag: remove a label assignment from a work item. `true` if a row was removed. */
  async deleteAssignment(
    runner: TenantQueryRunner,
    context: TenantContext,
    workItemId: string,
    labelId: string,
  ): Promise<boolean> {
    const existing = await this.findAssignment(runner, context, workItemId, labelId);
    if (!existing) return false;
    await tenantDrizzle(runner)
      .delete(workItemLabels)
      .where(
        and(
          eq(workItemLabels.organizationId, context.organizationId),
          eq(workItemLabels.workItemId, workItemId),
          eq(workItemLabels.labelId, labelId),
        ),
      );
    return true;
  }
}
