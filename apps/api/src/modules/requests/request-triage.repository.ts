import { and, eq, sql } from 'drizzle-orm';
import { uuidv7 } from '@tmanage/domain';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import { clientRequests, memberships, requestTriage } from '../../common/database/schema.js';
import type { RequestTriageRow } from '../../common/database/schema.js';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';

/**
 * Request triage store — resolve the request being triaged, resolve a named assignee, read the
 * current triage, and upsert it (REQ-02 request triage, x265).
 *
 * Every method names the acting tenant and filters on `organization_id`: there is deliberately no
 * un-scoped read, for the reason ADR-0001 exists — on MySQL such a query returns another studio's
 * row. The controller owns policy (the category allowlist and the relation-scoped `authorize()`);
 * this store owns the queries. The write is a single `INSERT ... ON DUPLICATE KEY UPDATE`, so a
 * re-triage updates in place and two racing saves serialise on `uq_request_triage_org_request`
 * rather than on a row this code read first.
 */

/** Just the fields of a client request triage needs — its project and client org, to relation-check. */
export interface TriagedRequestRow {
  readonly id: string;
  readonly organizationId: string;
  readonly projectId: string;
  readonly clientOrganizationId: string;
}

export class RequestTriageRepository {
  /** The request being triaged, scoped to the acting tenant. `null` when it does not exist here. */
  async findRequest(
    runner: TenantQueryRunner,
    context: TenantContext,
    requestId: string,
  ): Promise<TriagedRequestRow | null> {
    const rows = await tenantDrizzle(runner)
      .select({
        id: clientRequests.id,
        organizationId: clientRequests.organizationId,
        projectId: clientRequests.projectId,
        clientOrganizationId: clientRequests.clientOrganizationId,
      })
      .from(clientRequests)
      .where(
        and(
          eq(clientRequests.organizationId, context.organizationId),
          eq(clientRequests.id, requestId),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  /**
   * Whether a membership is an active member of the acting tenant — the assignee gate. Returns the id
   * when it exists and is `active`, else `null` (an unknown, cross-tenant, or non-active membership is
   * not a valid assignee, so the caller turns `null` into a 404).
   */
  async findActiveMembershipId(
    runner: TenantQueryRunner,
    context: TenantContext,
    membershipId: string,
  ): Promise<string | null> {
    const rows = await tenantDrizzle(runner)
      .select({ id: memberships.id })
      .from(memberships)
      .where(
        and(
          eq(memberships.organizationId, context.organizationId),
          eq(memberships.id, membershipId),
          eq(memberships.status, 'active'),
        ),
      )
      .limit(1);
    return rows[0]?.id ?? null;
  }

  /** The current triage for a request, scoped to the acting tenant. `null` when it is not yet triaged. */
  async findTriage(
    runner: TenantQueryRunner,
    context: TenantContext,
    requestId: string,
  ): Promise<RequestTriageRow | null> {
    const rows = await tenantDrizzle(runner)
      .select()
      .from(requestTriage)
      .where(
        and(
          eq(requestTriage.organizationId, context.organizationId),
          eq(requestTriage.requestId, requestId),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  /** Create or replace the triage for a request in this studio. Idempotent by the unique key. */
  async upsert(
    runner: TenantQueryRunner,
    context: TenantContext,
    requestId: string,
    category: string,
    assigneeMembershipId: string | null,
  ): Promise<void> {
    await tenantDrizzle(runner)
      .insert(requestTriage)
      .values({
        id: uuidv7(),
        organizationId: context.organizationId,
        requestId,
        category,
        assigneeMembershipId,
        createdAt: sql`current_timestamp(3)`,
        updatedAt: sql`current_timestamp(3)`,
      })
      .onDuplicateKeyUpdate({
        set: {
          category,
          assigneeMembershipId,
        },
      });
  }
}
