import { and, desc, eq, isNotNull, isNull } from 'drizzle-orm';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import { workItems } from '../../common/database/schema.js';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';

/** How many recent dated items the project's pace is measured over (one read, at most this many rows). */
export const SUGGEST_DUE_SAMPLE_SIZE = 50;

/** One dated item's created and due instants. */
export interface DatedItem {
  readonly createdAt: Date;
  readonly dueAt: Date | null;
}

/** The project's last {@link SUGGEST_DUE_SAMPLE_SIZE} live items that have a due date, newest first. */
export async function readDatedItems(
  runner: TenantQueryRunner,
  context: TenantContext,
  projectId: string,
): Promise<readonly DatedItem[]> {
  return tenantDrizzle(runner)
    .select({ createdAt: workItems.createdAt, dueAt: workItems.dueAt })
    .from(workItems)
    .where(
      and(
        eq(workItems.organizationId, context.organizationId),
        eq(workItems.projectId, projectId),
        isNotNull(workItems.dueAt),
        isNull(workItems.deletedAt),
      ),
    )
    .orderBy(desc(workItems.createdAt))
    .limit(SUGGEST_DUE_SAMPLE_SIZE);
}
