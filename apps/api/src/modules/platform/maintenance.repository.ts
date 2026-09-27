import { uuidv7 } from '@tmanage/domain';
import { and, asc, eq, gt, sql } from 'drizzle-orm';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import { maintenanceWindows } from '../../common/database/schema.js';
import type { MaintenanceWindowRow } from '../../common/database/schema.js';
import type { IdentityQueryRunner, TenantDatabase } from '../../common/database/tenant-context.js';

/**
 * Platform states (x185) — the maintenance-window store.
 *
 * `maintenance_windows` is a GLOBAL, org-less table (0080): a maintenance window describes the whole
 * service and is read by the app shell before any organization is resolved, so every method runs on
 * the identity (no-tenant) path — there is no `TenantContext` here and there could not be. The
 * table's entry in `NON_TENANT_TABLES` is what lets the identity runner reach it.
 *
 * The read filters `published = 1` and `ends_at > now` in SQL — the public-visibility gate lives in
 * the database, so a draft or a finished window is never returned even if a caller reaches this
 * repository another way. The write (schedule) is authorized against a tenant in the controller
 * (`org.manage`) but persists globally; the runtime user holds INSERT and nothing else on this table.
 */
export class MaintenanceWindowsRepository {
  constructor(private readonly database: TenantDatabase) {}

  /**
   * Published windows that have not yet ended (`ends_at > now`), soonest-starting first, bounded to
   * `limit`. The current window sorts before any later one, so the controller can take the head as
   * the current-or-next window. `now` is passed in so the boundary is the request's clock, not this
   * process's, and the read stays deterministic under test.
   */
  async listPublishableWindows(
    runner: IdentityQueryRunner,
    now: Date,
    limit: number,
  ): Promise<readonly MaintenanceWindowRow[]> {
    return tenantDrizzle(runner)
      .select()
      .from(maintenanceWindows)
      .where(and(eq(maintenanceWindows.published, true), gt(maintenanceWindows.endsAt, now)))
      .orderBy(asc(maintenanceWindows.startsAt))
      .limit(limit);
  }

  /**
   * Insert one window and return its id and server-stamped `createdAt`. The caller has already
   * validated the severity and the `starts_at < ends_at` order (see `maintenance.controller.ts`);
   * the column widths and the `severity` ENUM are the second line of defence. `created_at` is the
   * server's clock (`current_timestamp(3)`), never this process's, as the identity writers do.
   */
  async insert(input: {
    message: string;
    severity: MaintenanceWindowRow['severity'];
    startsAt: Date;
    endsAt: Date;
    published: boolean;
    correlationId: string;
  }): Promise<{ id: string; createdAt: Date }> {
    const id = uuidv7();
    const createdAt = await this.database.identityTransaction(
      { correlationId: input.correlationId, tables: ['maintenance_windows'] },
      async (tx) => {
        await tenantDrizzle(tx)
          .insert(maintenanceWindows)
          .values({
            id,
            message: input.message,
            severity: input.severity,
            startsAt: input.startsAt,
            endsAt: input.endsAt,
            published: input.published,
            createdAt: sql`current_timestamp(3)`,
          });
        const [row] = await tenantDrizzle(tx)
          .select({ createdAt: maintenanceWindows.createdAt })
          .from(maintenanceWindows)
          .where(eq(maintenanceWindows.id, id))
          .limit(1);
        return row?.createdAt ?? new Date();
      },
    );
    return { id, createdAt };
  }
}
