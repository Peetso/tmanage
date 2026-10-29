import { uuidv7 } from '@tmanage/domain';
import type { RowDataPacket } from 'mysql2';
import { and, asc, eq, gt, sql } from 'drizzle-orm';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import { maintenanceWindows } from '../../common/database/schema.js';
import type { MaintenanceWindowRow } from '../../common/database/schema.js';
import type { IdentityQueryRunner, TenantDatabase } from '../../common/database/tenant-context.js';
import {
  SQL as PLATFORM_SQL,
  insertPlatformAudit as insertFullPlatformAudit,
} from '../platform-admin/platform-admin.repository.js';
import type { PlatformAuditInput } from '../platform-admin/platform-admin.repository.js';

/** Wave 9 S8 (F07): a window and its platform audit row are written in one transaction. */
const WRITE_TABLES = ['maintenance_windows', 'platform_admin_audit_events'] as const;

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
 * repository another way.
 *
 * Wave 9 S8 (F07): writing a window is a platform-operator action. The controller is
 * `/v1/platform/maintenance` behind `PlatformAdminGuard` (no organization role reaches it), and
 * {@link schedule} / {@link unpublish} write the window change and its `platform_admin_audit_events`
 * row in ONE identity transaction, so a window never exists without the operator's typed reason.
 * The runtime user holds INSERT and UPDATE (the unpublish) on this table, never DELETE.
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

  /**
   * F07: schedule one window and append the operator's platform audit row, atomically. The audit
   * row names the window id as its target; a failure of either statement rolls back both.
   */
  async schedule(
    input: {
      message: string;
      severity: MaintenanceWindowRow['severity'];
      startsAt: Date;
      endsAt: Date;
      published: boolean;
      // ---- platform-admin v2 · PA-10 ---- (0244 columns, optional so older callers fit)
      messageAr?: string | null;
      blockSignIn?: boolean;
    },
    audit: Omit<PlatformAuditInput, 'targetId' | 'targetType'>,
  ): Promise<{ id: string; createdAt: Date }> {
    const id = uuidv7();
    const createdAt = await this.database.identityTransaction(
      { correlationId: audit.correlationId, tables: [...WRITE_TABLES] },
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
        if (input.messageAr != null || input.blockSignIn === true) {
          await tx.query(MAINTENANCE_SQL.extras, [
            input.messageAr ?? null,
            input.blockSignIn === true ? 1 : 0,
            id,
          ]);
        }
        await insertPlatformAudit(tx, { ...audit, targetType: 'platform', targetId: id });
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

  /**
   * F07: take one window off the banner (`published = 0`) with the operator's audit row, atomically.
   * `false` when no such window exists (the controller answers 404 and nothing is written). An
   * already-unpublished window stays unpublished; the operator's action is still recorded.
   */
  async unpublish(
    windowId: string,
    audit: Omit<PlatformAuditInput, 'targetId' | 'targetType'>,
  ): Promise<boolean> {
    return this.database.identityTransaction(
      { correlationId: audit.correlationId, tables: [...WRITE_TABLES] },
      async (tx) => {
        const [row] = await tenantDrizzle(tx)
          .select({ id: maintenanceWindows.id })
          .from(maintenanceWindows)
          .where(eq(maintenanceWindows.id, windowId))
          .limit(1);
        if (!row) return false;
        await tenantDrizzle(tx)
          .update(maintenanceWindows)
          .set({ published: false })
          .where(eq(maintenanceWindows.id, windowId));
        await insertPlatformAudit(tx, { ...audit, targetType: 'platform', targetId: windowId });
        return true;
      },
    );
  }

  // ---- platform-admin v2 · PA-10 ----

  /** Every window, newest start first (D4 list). */
  async listAll(limit: number, correlationId: string): Promise<readonly MaintenanceWindowRecord[]> {
    return this.database.identityRead(
      { correlationId, tables: ['maintenance_windows'] },
      async (db) => (await db.query<Row[]>(MAINTENANCE_SQL.list, [limit])).map(toRecord),
    );
  }

  async find(id: string, correlationId: string): Promise<MaintenanceWindowRecord | null> {
    return this.database.identityRead(
      { correlationId, tables: ['maintenance_windows'] },
      async (db) => {
        const [row] = await db.query<Row[]>(MAINTENANCE_SQL.byId, [id]);
        return row ? toRecord(row) : null;
      },
    );
  }

  /** Edit one window's content and switches. `false` when there is no such window. */
  async update(
    id: string,
    input: {
      message: string;
      messageAr: string | null;
      severity: MaintenanceWindowRow['severity'];
      startsAt: Date;
      endsAt: Date;
      published: boolean;
      blockSignIn: boolean;
    },
    audit: PlatformAuditInput,
  ): Promise<boolean> {
    return this.database.identityTransaction(
      { correlationId: audit.correlationId, tables: [...WRITE_TABLES] },
      async (tx) => {
        const [row] = await tx.query<Row[]>(MAINTENANCE_SQL.byId, [id]);
        if (!row) return false;
        await tx.query(MAINTENANCE_SQL.update, [
          input.message,
          input.messageAr,
          input.severity,
          input.startsAt,
          input.endsAt,
          input.published ? 1 : 0,
          input.blockSignIn ? 1 : 0,
          id,
        ]);
        await insertFullPlatformAudit(tx, audit);
        return true;
      },
    );
  }

  /** Publish (or unpublish) one window. `false` when there is no such window. */
  async setPublished(id: string, published: boolean, audit: PlatformAuditInput): Promise<boolean> {
    return this.database.identityTransaction(
      { correlationId: audit.correlationId, tables: [...WRITE_TABLES] },
      async (tx) => {
        const [row] = await tx.query<Row[]>(MAINTENANCE_SQL.byId, [id]);
        if (!row) return false;
        await tx.query(MAINTENANCE_SQL.publish, [published ? 1 : 0, id]);
        await insertFullPlatformAudit(tx, audit);
        return true;
      },
    );
  }

  /**
   * "End now": the window ends at `now` (`ends_at` and `ended_at`), so the banner disappears and
   * the sign-in block lifts at once. A window that has not started yet starts and ends at `now`.
   */
  async end(id: string, now: Date, audit: PlatformAuditInput): Promise<boolean> {
    return this.database.identityTransaction(
      { correlationId: audit.correlationId, tables: [...WRITE_TABLES] },
      async (tx) => {
        const [row] = await tx.query<Row[]>(MAINTENANCE_SQL.byId, [id]);
        if (!row) return false;
        await tx.query(MAINTENANCE_SQL.end, [now, now, now, id]);
        await insertFullPlatformAudit(tx, audit);
        return true;
      },
    );
  }

  /**
   * The window that blocks sign-in right now, if any: published, severity `down`, block on, not
   * ended, `starts_at <= now < ends_at`. Read by the sign-in gate on every password sign-in.
   */
  async activeSignInBlock(
    now: Date,
    correlationId: string,
  ): Promise<MaintenanceWindowRecord | null> {
    return this.database.identityRead(
      { correlationId, tables: ['maintenance_windows'] },
      async (db) => {
        const [row] = await db.query<Row[]>(MAINTENANCE_SQL.signInBlock, [now, now]);
        return row ? toRecord(row) : null;
      },
    );
  }
}

/** The platform audit insert, the same statement `PlatformAdminRepository` issues. */
async function insertPlatformAudit(
  tx: IdentityQueryRunner,
  audit: PlatformAuditInput,
): Promise<void> {
  await tx.query(PLATFORM_SQL.insertAudit, [
    uuidv7(),
    audit.actorUserId,
    audit.actorEmail,
    audit.action,
    audit.targetType,
    audit.targetId,
    audit.targetLabel,
    audit.reason,
    audit.correlationId,
  ]);
}

// ---- platform-admin v2 · PA-10 ----

/** One window with the 0244 columns, as the D4 screen and the sign-in gate read it. */
export interface MaintenanceWindowRecord {
  readonly id: string;
  readonly message: string;
  readonly messageAr: string | null;
  readonly severity: MaintenanceWindowRow['severity'];
  readonly startsAt: Date;
  readonly endsAt: Date;
  readonly published: boolean;
  readonly blockSignIn: boolean;
  readonly createdAt: Date;
  readonly updatedAt: Date | null;
  readonly endedAt: Date | null;
}

type Row = RowDataPacket & Record<string, unknown>;

const COLUMNS = `mw.id as id, mw.message as message, mw.message_ar as message_ar,
  mw.severity as severity, mw.starts_at as starts_at, mw.ends_at as ends_at,
  mw.published as published, mw.block_sign_in as block_sign_in, mw.created_at as created_at,
  mw.updated_at as updated_at, mw.ended_at as ended_at`;

export const MAINTENANCE_SQL = {
  extras: `update maintenance_windows set message_ar = ?, block_sign_in = ? where id = ?`,
  list: `select ${COLUMNS} from maintenance_windows mw order by mw.starts_at desc limit ?`,
  byId: `select ${COLUMNS} from maintenance_windows mw where mw.id = ? limit 1`,
  update: `update maintenance_windows set message = ?, message_ar = ?, severity = ?,
      starts_at = ?, ends_at = ?, published = ?, block_sign_in = ?,
      updated_at = current_timestamp(3)
    where id = ?`,
  publish: `update maintenance_windows set published = ?, updated_at = current_timestamp(3)
    where id = ?`,
  end: `update maintenance_windows
    set starts_at = least(starts_at, ?), ends_at = least(ends_at, ?),
      ended_at = coalesce(ended_at, ?), updated_at = current_timestamp(3)
    where id = ?`,
  signInBlock: `select ${COLUMNS} from maintenance_windows mw
    where mw.published = 1 and mw.block_sign_in = 1 and mw.severity = 'down'
      and mw.ended_at is null and mw.starts_at <= ? and mw.ends_at > ?
    order by mw.starts_at asc limit 1`,
} as const;

function bool(value: unknown): boolean {
  return value === true || value === 1 || value === '1';
}

function date(value: unknown): Date | null {
  if (value === null || value === undefined) return null;
  const parsed = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function toRecord(row: Row): MaintenanceWindowRecord {
  return {
    id: String(row['id']),
    message: String(row['message'] ?? ''),
    messageAr: row['message_ar'] == null ? null : String(row['message_ar']),
    severity: String(row['severity']) as MaintenanceWindowRow['severity'],
    startsAt: date(row['starts_at']) ?? new Date(0),
    endsAt: date(row['ends_at']) ?? new Date(0),
    published: bool(row['published']),
    blockSignIn: bool(row['block_sign_in']),
    createdAt: date(row['created_at']) ?? new Date(0),
    updatedAt: date(row['updated_at']),
    endedAt: date(row['ended_at']),
  };
}
