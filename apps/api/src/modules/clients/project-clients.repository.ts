import { and, asc, eq, sql } from 'drizzle-orm';
import { uuidv7 } from '@tmanage/domain';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import { projectClients } from '../../common/database/schema.js';
import type { ProjectClientRow } from '../../common/database/schema.js';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';

/**
 * Which client organizations may see which projects — CLIENT-001's last storage gap.
 *
 * This is the smallest table in the tenancy migration and the one that decides the most. A row
 * here is the entire reason a client principal can reach a project at all:
 * `PrincipalRepository.projectScope` reads exactly this table for a client, and the authorizer
 * then refuses anything outside the ids it returns. Adding a row grants access to a project;
 * removing one withdraws it. There is no second switch.
 *
 * ## Why there is no `update`
 *
 * A share is an identity, not a record with fields: `(organization_id, project_id,
 * client_organization_id)` is the whole of it, and `uq_project_clients_identity` enforces that
 * there is at most one. Changing which client a project is shared with is a revoke and a
 * grant, which is two audit events describing two decisions, rather than one `UPDATE` that
 * would record a single ambiguous "changed".
 *
 * ## Why `unshare` is a real delete
 *
 * Every other removal in this codebase is a state — `archived_at`, `deleted_at`, a status —
 * because approvals, deliverables and audit events reference the row. Nothing references a
 * share row. It carries no history of its own, and what actually happened is preserved where
 * it belongs: in `audit_events`, which is append-only and cannot be edited by the code that
 * writes it.
 *
 * A soft-deleted share would also be a hazard rather than a record. Every read that decides
 * access would have to remember to exclude it, and one that forgot would hand a former client
 * a live project.
 *
 * ## What is not checked here, and why that is safe
 *
 * Neither the project nor the client organization is verified to belong to the tenant. Both
 * composite foreign keys — `fk_project_clients_project_tenant` and
 * `fk_project_clients_client_org_tenant` — include `organization_id`, so the database refuses
 * a project from tenant A shared with a client of tenant B even if an application bug supplies
 * both ids. Re-checking in the repository would duplicate a guarantee that cannot be bypassed
 * and would drift from it. The *service* still reads both first, for a different reason: to
 * answer 404 rather than 500 when a caller names something that is not there.
 */

export class ProjectClientNotFoundError extends Error {
  constructor(readonly projectClientId: string) {
    super(`Project client ${projectClientId} was not found`);
    this.name = 'ProjectClientNotFoundError';
  }
}

export interface ShareProjectInput {
  readonly projectId: string;
  readonly clientOrganizationId: string;
}

export interface ListProjectClientsOptions {
  /** Every client of one project. */
  readonly projectId?: string;
  /** Every project shared with one client organization. */
  readonly clientOrganizationId?: string;
  readonly after?: string;
  readonly limit?: number;
}

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;

export class ProjectClientsRepository {
  async list(
    runner: TenantQueryRunner,
    context: TenantContext,
    options: ListProjectClientsOptions = {},
  ): Promise<readonly ProjectClientRow[]> {
    const limit = Math.min(Math.max(options.limit ?? DEFAULT_PAGE_SIZE, 1), MAX_PAGE_SIZE);

    const predicates = [eq(projectClients.organizationId, context.organizationId)];
    if (options.projectId) predicates.push(eq(projectClients.projectId, options.projectId));
    if (options.clientOrganizationId) {
      predicates.push(eq(projectClients.clientOrganizationId, options.clientOrganizationId));
    }

    return tenantDrizzle(runner)
      .select()
      .from(projectClients)
      .where(and(...predicates))
      .orderBy(asc(projectClients.id))
      .limit(limit);
  }

  async findById(
    runner: TenantQueryRunner,
    context: TenantContext,
    projectClientId: string,
  ): Promise<ProjectClientRow | undefined> {
    const rows = await tenantDrizzle(runner)
      .select()
      .from(projectClients)
      .where(
        and(
          eq(projectClients.organizationId, context.organizationId),
          eq(projectClients.id, projectClientId),
        ),
      )
      .limit(1);
    return rows[0];
  }

  /** The share, if this project is already shared with this client. */
  async find(
    runner: TenantQueryRunner,
    context: TenantContext,
    input: ShareProjectInput,
  ): Promise<ProjectClientRow | undefined> {
    const rows = await tenantDrizzle(runner)
      .select()
      .from(projectClients)
      .where(
        and(
          eq(projectClients.organizationId, context.organizationId),
          eq(projectClients.projectId, input.projectId),
          eq(projectClients.clientOrganizationId, input.clientOrganizationId),
        ),
      )
      .limit(1);
    return rows[0];
  }

  /**
   * Share a project with a client organization.
   *
   * Idempotent by design: sharing something already shared returns the existing row rather
   * than raising. Granting access twice is not a mistake worth refusing, and a caller who
   * retried a request whose response was lost should not be told the grant failed.
   *
   * The existence check and the insert are in the caller's transaction, and
   * `uq_project_clients_identity` is the actual guarantee — two concurrent shares race to the
   * unique key, and the loser's duplicate-key error is what `share` reports rather than a
   * second row appearing.
   */
  async share(
    runner: TenantQueryRunner,
    context: TenantContext,
    input: ShareProjectInput,
  ): Promise<ProjectClientRow> {
    const existing = await this.find(runner, context, input);
    if (existing) return existing;

    const id = uuidv7();
    await tenantDrizzle(runner)
      .insert(projectClients)
      .values({
        id,
        // From the context. Not from `input` — there is no such field.
        organizationId: context.organizationId,
        projectId: input.projectId,
        clientOrganizationId: input.clientOrganizationId,
        createdAt: sql`current_timestamp(3)`,
      });

    const created = await this.findById(runner, context, id);
    if (!created) throw new ProjectClientNotFoundError(id);
    return created;
  }

  /**
   * Withdraw a share.
   *
   * Returns whether a row was removed, so a caller can tell "revoked" from "was not shared"
   * without a second read — and so the audit event says which of the two happened.
   */
  async unshare(
    runner: TenantQueryRunner,
    context: TenantContext,
    input: ShareProjectInput,
  ): Promise<boolean> {
    const result = await tenantDrizzle(runner)
      .delete(projectClients)
      .where(
        and(
          eq(projectClients.organizationId, context.organizationId),
          eq(projectClients.projectId, input.projectId),
          eq(projectClients.clientOrganizationId, input.clientOrganizationId),
        ),
      );

    return result[0].affectedRows > 0;
  }
}
