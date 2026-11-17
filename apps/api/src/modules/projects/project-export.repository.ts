import { and, asc, eq, inArray, isNotNull, isNull } from 'drizzle-orm';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import { memberships, users, workItemLabels, workItems } from '../../common/database/schema.js';
import type { WorkItemRow } from '../../common/database/schema.js';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';

/** How many ids one `IN (…)` list carries; the label and owner reads walk the items in chunks. */
const ID_CHUNK = 500;

function chunks<T>(values: readonly T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < values.length; i += ID_CHUNK) out.push(values.slice(i, i + ID_CHUNK));
  return out;
}

/**
 * 54-29 — the per-project export's reads. Every statement is bound to the caller's tenant
 * (`organization_id` from the `TenantContext`, never from the request) and to a limit; the
 * service decides who may export and what to do past the cap. No policy here.
 */
export class ProjectExportRepository {
  /**
   * The project's live work items in id order, at most `limit` rows. The service asks for one
   * more than its cap, so a project past the cap is a 413 rather than a silently short file.
   */
  async listItems(
    runner: TenantQueryRunner,
    context: TenantContext,
    projectId: string,
    limit: number,
  ): Promise<readonly WorkItemRow[]> {
    return tenantDrizzle(runner)
      .select()
      .from(workItems)
      .where(
        and(
          eq(workItems.organizationId, context.organizationId),
          eq(workItems.projectId, projectId),
          isNull(workItems.deletedAt),
        ),
      )
      .orderBy(asc(workItems.id))
      .limit(Math.max(1, Math.trunc(limit)));
  }

  /** Label names per work item, for these items of this tenant. */
  async labelsByItem(
    runner: TenantQueryRunner,
    context: TenantContext,
    workItemIds: readonly string[],
  ): Promise<ReadonlyMap<string, readonly string[]>> {
    const result = new Map<string, string[]>();
    if (workItemIds.length === 0) return result;
    const definitions = await tenantDrizzle(runner)
      .select({ id: workItemLabels.id, name: workItemLabels.name })
      .from(workItemLabels)
      .where(
        and(
          eq(workItemLabels.organizationId, context.organizationId),
          isNull(workItemLabels.workItemId),
        ),
      )
      .limit(10_000);
    const nameOf = new Map(definitions.map((row) => [row.id, row.name ?? ''] as const));
    for (const ids of chunks(workItemIds)) {
      const rows = await tenantDrizzle(runner)
        .select({ workItemId: workItemLabels.workItemId, labelId: workItemLabels.labelId })
        .from(workItemLabels)
        .where(
          and(
            eq(workItemLabels.organizationId, context.organizationId),
            inArray(workItemLabels.workItemId, ids),
            isNotNull(workItemLabels.labelId),
          ),
        )
        .orderBy(asc(workItemLabels.id))
        .limit(ids.length * 50);
      for (const row of rows) {
        const name = row.labelId === null ? undefined : nameOf.get(row.labelId);
        if (row.workItemId === null || !name) continue;
        const list = result.get(row.workItemId) ?? [];
        list.push(name);
        result.set(row.workItemId, list);
      }
    }
    return result;
  }

  /** Sign-in addresses of these users, only where they are members of this tenant. */
  async ownerEmails(
    runner: TenantQueryRunner,
    context: TenantContext,
    userIds: readonly string[],
  ): Promise<ReadonlyMap<string, string>> {
    const result = new Map<string, string>();
    for (const ids of chunks([...new Set(userIds)])) {
      const rows = await tenantDrizzle(runner)
        .select({ id: users.id, email: users.email })
        .from(users)
        .innerJoin(memberships, eq(memberships.userId, users.id))
        .where(and(eq(memberships.organizationId, context.organizationId), inArray(users.id, ids)))
        .limit(ids.length);
      for (const row of rows) result.set(row.id, row.email.toLowerCase());
    }
    return result;
  }
}
