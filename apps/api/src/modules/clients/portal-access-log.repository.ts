import { and, desc, eq, lt } from 'drizzle-orm';
import { sql } from 'drizzle-orm';
import { uuidv7 } from '@tmanage/domain';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import {
  clientMemberships,
  clientOrganizations,
  portalAccessLog,
} from '../../common/database/schema.js';
import type { PortalAccessLogRow, PortalAccessResourceKind } from '../../common/database/schema.js';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';

/**
 * The portal-access-log repository — SEC / Client portal access log (x237), following the
 * append-only `meeting_notes` (0033) and `audit_events` (0002) pattern.
 *
 * `25-AUTHORIZATION-AND-TENANT-ISOLATION` §6 is honoured structurally, exactly as every sibling
 * repository honours it:
 *
 * 1. **No unscoped read/write.** Every method's first two parameters are the `TenantQueryRunner`
 *    for the current unit of work and the `TenantContext`; there is no overload without a context.
 * 2. **The tenant comes from the context, never the DTO.** {@link RecordPortalAccessInput} has no
 *    `organizationId` field, so nothing a request carries can choose the tenant it writes into.
 * 3. **The tenant predicate is on every statement**, built with Drizzle and executed through the
 *    guard, so a forgotten predicate throws rather than leaking rows.
 *
 * Append-only: `record` inserts and `list` reads; there is no update and no delete, and `0109`'s
 * triggers refuse both at the engine besides.
 */

/** Note what is absent: `organizationId` (from the context) and `id`/`accessedAt` (server-side). */
export interface RecordPortalAccessInput {
  readonly projectId: string;
  /** The client membership that accessed the resource — the service passes `principal.membershipId`. */
  readonly clientMemberId: string;
  readonly resourceKind: PortalAccessResourceKind;
}

export interface ListPortalAccessOptions {
  /** Required: this reads one project's access events, never a whole tenant's. */
  readonly projectId: string;
  /**
   * Keyset cursor. Reads run **newest first**, so the cursor is exclusive-upper: pass the id of the
   * oldest row you have and receive the ones before it.
   */
  readonly before?: string;
  readonly limit?: number;
}

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;

export function effectivePageSize(limit: number | undefined): number {
  return Math.min(Math.max(limit ?? DEFAULT_PAGE_SIZE, 1), MAX_PAGE_SIZE);
}

export class PortalAccessLogRepository {
  /**
   * Append one access event.
   *
   * The id is generated here (UUIDv7, so ids sort in creation order). `organization_id` comes from
   * the context, never from `input`. The composite foreign keys refuse a project or a member of
   * another tenant, so a cross-tenant id is a database error rather than a silent row.
   */
  async record(
    runner: TenantQueryRunner,
    context: TenantContext,
    input: RecordPortalAccessInput,
  ): Promise<PortalAccessLogRow> {
    const db = tenantDrizzle(runner);
    const id = uuidv7();

    await db.insert(portalAccessLog).values({
      id,
      // From the context. Not from `input` — there is no such field.
      organizationId: context.organizationId,
      projectId: input.projectId,
      clientMemberId: input.clientMemberId,
      resourceKind: input.resourceKind,
      accessedAt: sql`current_timestamp(3)`,
    });

    const row = await this.findById(runner, context, id);
    if (!row) throw new Error(`portal access log ${id} vanished immediately after insert`);
    return row;
  }

  /** Fetch one event by id, within the acting tenant. No unscoped form. */
  async findById(
    runner: TenantQueryRunner,
    context: TenantContext,
    id: string,
  ): Promise<PortalAccessLogRow | null> {
    const db = tenantDrizzle(runner);
    const rows = await db
      .select()
      .from(portalAccessLog)
      .where(
        and(eq(portalAccessLog.organizationId, context.organizationId), eq(portalAccessLog.id, id)),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  /**
   * List one project's access events, within the acting tenant, newest first.
   *
   * Ordering is by `id` (UUIDv7 — time-ordered and unique), so a keyset page boundary can never
   * repeat or skip a row that shares a millisecond with its neighbour. The
   * `(organization_id, project_id, id)` index serves it.
   */
  async list(
    runner: TenantQueryRunner,
    context: TenantContext,
    options: ListPortalAccessOptions,
  ): Promise<readonly PortalAccessLogRow[]> {
    const limit = effectivePageSize(options.limit);
    const db = tenantDrizzle(runner);

    const predicates = [
      eq(portalAccessLog.organizationId, context.organizationId),
      eq(portalAccessLog.projectId, options.projectId),
    ];
    if (options.before) predicates.push(lt(portalAccessLog.id, options.before));

    return db
      .select()
      .from(portalAccessLog)
      .where(and(...predicates))
      .orderBy(desc(portalAccessLog.id))
      .limit(limit);
  }

  /**
   * A10 — the project's recent client reads of its updates timeline (`resource_kind = 'update'`),
   * newest first, each with the client company's name. The unpublish dialog uses the earliest one
   * after an update was posted to say "<Client> already opened this update on <date>". Every joined
   * table carries the tenant predicate.
   */
  async listUpdateOpens(
    runner: TenantQueryRunner,
    context: TenantContext,
    options: { readonly projectId: string; readonly limit?: number },
  ): Promise<readonly { readonly accessedAt: Date; readonly clientName: string }[]> {
    const limit = Math.min(Math.max(options.limit ?? 500, 1), 500);
    const db = tenantDrizzle(runner);
    return db
      .select({ accessedAt: portalAccessLog.accessedAt, clientName: clientOrganizations.name })
      .from(portalAccessLog)
      .innerJoin(
        clientMemberships,
        and(
          eq(clientMemberships.organizationId, portalAccessLog.organizationId),
          eq(clientMemberships.id, portalAccessLog.clientMemberId),
        ),
      )
      .innerJoin(
        clientOrganizations,
        and(
          eq(clientOrganizations.organizationId, clientMemberships.organizationId),
          eq(clientOrganizations.id, clientMemberships.clientOrganizationId),
        ),
      )
      .where(
        and(
          eq(portalAccessLog.organizationId, context.organizationId),
          eq(clientMemberships.organizationId, context.organizationId),
          eq(clientOrganizations.organizationId, context.organizationId),
          eq(portalAccessLog.projectId, options.projectId),
          eq(portalAccessLog.resourceKind, 'update'),
        ),
      )
      .orderBy(desc(portalAccessLog.id))
      .limit(limit);
  }
}
