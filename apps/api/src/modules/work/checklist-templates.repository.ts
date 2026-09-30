import { and, asc, eq, sql } from 'drizzle-orm';
import { uuidv7 } from '@tmanage/domain';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import { workChecklistTemplates, workItemChecklistItems } from '../../common/database/schema.js';
import type { WorkChecklistTemplateRow } from '../../common/database/schema.js';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';

/**
 * Reusable work-item checklist templates — x292's storage half (Work module 7).
 *
 * Follows `WorkLabelsRepository`: `TenantContext` is the scoping parameter, no `organizationId` on
 * any input type (it comes from the context), and every read and write is bound to
 * `(organization_id, …)` so a caller in the wrong tenant sees nothing rather than a leak. The
 * repository holds no policy — the service decides who may read, write or apply.
 *
 * Applying a template seeds rows into the existing `work_item_checklist_items` table (0051) through
 * this repository's own {@link seedChecklistItems}, keeping x292 file-disjoint from the checklist
 * slice: no method of `WorkChecklistRepository` is touched. The seed is idempotent — a label the
 * item's checklist already carries is skipped, so re-applying a template adds nothing.
 */

/** The largest template page a single read returns; mirrors the bounded reads elsewhere. */
export const MAX_TEMPLATES_PAGE = 500;

export interface CreateTemplateInput {
  readonly name: string;
  readonly labels: readonly string[];
  readonly createdBy: string | null;
}

export class WorkChecklistTemplatesRepository {
  /** The tenant's templates, name-ascending, bounded to one page. */
  async list(
    runner: TenantQueryRunner,
    context: TenantContext,
    limit: number = MAX_TEMPLATES_PAGE,
  ): Promise<readonly WorkChecklistTemplateRow[]> {
    return tenantDrizzle(runner)
      .select()
      .from(workChecklistTemplates)
      .where(eq(workChecklistTemplates.organizationId, context.organizationId))
      .orderBy(asc(workChecklistTemplates.name), asc(workChecklistTemplates.id))
      .limit(Math.min(Math.max(1, Math.trunc(limit)), MAX_TEMPLATES_PAGE));
  }

  /** One template, scoped to the tenant; `null` if absent. */
  async findById(
    runner: TenantQueryRunner,
    context: TenantContext,
    templateId: string,
  ): Promise<WorkChecklistTemplateRow | null> {
    const rows = await tenantDrizzle(runner)
      .select()
      .from(workChecklistTemplates)
      .where(
        and(
          eq(workChecklistTemplates.organizationId, context.organizationId),
          eq(workChecklistTemplates.id, templateId),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  /** A template with this name in the tenant; `null` if the name is free. */
  async findByName(
    runner: TenantQueryRunner,
    context: TenantContext,
    name: string,
  ): Promise<WorkChecklistTemplateRow | null> {
    const rows = await tenantDrizzle(runner)
      .select()
      .from(workChecklistTemplates)
      .where(
        and(
          eq(workChecklistTemplates.organizationId, context.organizationId),
          eq(workChecklistTemplates.name, name),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  /** Define a template. `labels` is stored whole as an ordered JSON array. */
  async create(
    runner: TenantQueryRunner,
    context: TenantContext,
    input: CreateTemplateInput,
  ): Promise<WorkChecklistTemplateRow> {
    const id = uuidv7();
    await tenantDrizzle(runner)
      .insert(workChecklistTemplates)
      .values({
        id,
        organizationId: context.organizationId,
        name: input.name,
        labelsJson: [...input.labels],
        createdBy: input.createdBy,
        createdAt: sql`current_timestamp(3)`,
      });

    const created = await this.findById(runner, context, id);
    if (!created) {
      // Unreachable: the insert above committed this row in this transaction.
      throw new Error('checklist template vanished immediately after insert');
    }
    return created;
  }

  /** Remove a template. `true` if a row was removed. */
  async delete(
    runner: TenantQueryRunner,
    context: TenantContext,
    templateId: string,
  ): Promise<boolean> {
    const existing = await this.findById(runner, context, templateId);
    if (!existing) return false;
    await tenantDrizzle(runner)
      .delete(workChecklistTemplates)
      .where(
        and(
          eq(workChecklistTemplates.organizationId, context.organizationId),
          eq(workChecklistTemplates.id, templateId),
        ),
      );
    return true;
  }

  /**
   * Seed a work item's checklist from an ordered list of labels, tenant-scoped and idempotent.
   *
   * The labels the item's checklist already carries are read first and skipped; the remaining
   * labels are appended in order, one past the current highest position. Re-applying the same
   * template therefore inserts nothing. Returns the number of checklist items created.
   */
  async seedChecklistItems(
    runner: TenantQueryRunner,
    context: TenantContext,
    workItemId: string,
    labels: readonly string[],
  ): Promise<number> {
    const existing = await tenantDrizzle(runner)
      .select({ label: workItemChecklistItems.label })
      .from(workItemChecklistItems)
      .where(
        and(
          eq(workItemChecklistItems.organizationId, context.organizationId),
          eq(workItemChecklistItems.workItemId, workItemId),
        ),
      );
    const present = new Set(existing.map((row) => row.label));

    const [aggregate] = await tenantDrizzle(runner)
      .select({ maxPosition: sql<number | null>`max(${workItemChecklistItems.position})` })
      .from(workItemChecklistItems)
      .where(
        and(
          eq(workItemChecklistItems.organizationId, context.organizationId),
          eq(workItemChecklistItems.workItemId, workItemId),
        ),
      );
    let nextPosition =
      aggregate?.maxPosition === null || aggregate?.maxPosition === undefined
        ? 0
        : Number(aggregate.maxPosition) + 1;

    let seeded = 0;
    for (const label of labels) {
      if (present.has(label)) continue;
      present.add(label);
      await tenantDrizzle(runner)
        .insert(workItemChecklistItems)
        .values({
          id: uuidv7(),
          organizationId: context.organizationId,
          workItemId,
          label,
          done: false,
          position: nextPosition,
          createdAt: sql`current_timestamp(3)`,
        });
      nextPosition += 1;
      seeded += 1;
    }
    return seeded;
  }
}
