import { and, asc, eq, gt, inArray, isNull, sql } from 'drizzle-orm';
import { uuidv7 } from '@tmanage/domain';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import { clientOrganizations } from '../../common/database/schema.js';
import type { ClientOrganizationRow } from '../../common/database/schema.js';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';

/**
 * Client organizations — PROJ-001 / CLIENT-001's storage half.
 *
 * Follows `ProjectsRepository` exactly: `TenantContext` as the scoping parameter, no
 * `organizationId` on any input type, keyset pagination, optimistic concurrency, and
 * not-found rather than conflict for a caller in the wrong tenant.
 *
 * ## What this table is, and the thing about it that is easy to get wrong
 *
 * A client organization belongs to **exactly one** service organization. Migration 0001 says
 * it in the schema comment and it is worth restating where the code is: two service
 * organizations that both work with the same real-world company hold two separate, unrelated
 * `client_organizations` rows. There is no shared record and no global "company" entity.
 *
 * That is why every method here is tenant-scoped in the ordinary way and why there is no
 * `findByName` across tenants. A directory of client companies spanning tenants would be a
 * cross-tenant read with no predicate to carry — the same shape as the one read the
 * membership resolver is the sole waiver for, and there is no invariant here that would
 * justify a second waiver.
 *
 * ## Concurrency token
 *
 * `updated_at`, not a `version` column, because `client_organizations` has no version column
 * in `0001_tenancy.sql` — the same position `projects` is in, and for the same reason the
 * same choice is made. `memberships` and `work_items` do have one and their repositories use
 * it. The repository uses whichever token the table actually provides rather than imposing a
 * house style over the top of both.
 */

export class ClientOrganizationNotFoundError extends Error {
  constructor(readonly clientOrganizationId: string) {
    // No organization id in the message. A caller probing for another tenant's client should
    // learn nothing from the difference between "does not exist" and "exists elsewhere"
    // (spec §4).
    super(`Client organization ${clientOrganizationId} was not found`);
    this.name = 'ClientOrganizationNotFoundError';
  }
}

export class ClientOrganizationVersionConflictError extends Error {
  constructor(
    readonly clientOrganizationId: string,
    readonly expectedVersion: number,
  ) {
    super(
      `Client organization ${clientOrganizationId} was modified concurrently ` +
        `(expected version ${expectedVersion})`,
    );
    this.name = 'ClientOrganizationVersionConflictError';
  }
}

/**
 * Note what is absent: `organizationId`. It is taken from the context, so there is no field
 * for a request body to populate and no code path that could prefer one over the other.
 */
export interface CreateClientOrganizationInput {
  readonly name: string;
}

export interface UpdateClientOrganizationInput {
  readonly name?: string;
}

export interface ListClientOrganizationsOptions {
  /** Keyset pagination. Cursors are ids, and the sort is by id. */
  readonly after?: string;
  readonly limit?: number;
  /** Archived client organizations are excluded unless asked for. */
  readonly includeArchived?: boolean;
}

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;

export class ClientOrganizationsRepository {
  async list(
    runner: TenantQueryRunner,
    context: TenantContext,
    options: ListClientOrganizationsOptions = {},
  ): Promise<readonly ClientOrganizationRow[]> {
    const limit = Math.min(Math.max(options.limit ?? DEFAULT_PAGE_SIZE, 1), MAX_PAGE_SIZE);

    const predicates = [eq(clientOrganizations.organizationId, context.organizationId)];
    if (!options.includeArchived) predicates.push(isNull(clientOrganizations.archivedAt));
    if (options.after) predicates.push(gt(clientOrganizations.id, options.after));

    return tenantDrizzle(runner)
      .select()
      .from(clientOrganizations)
      .where(and(...predicates))
      .orderBy(asc(clientOrganizations.id))
      .limit(limit);
  }

  /**
   * Fetch several client organizations by id in one query, within the acting tenant.
   *
   * `findById`'s rule for many: no archive predicate and no page cap, so a name is answered
   * here exactly as `findById` answers it — an archived client's requests still name their
   * client. `list` is the paged, active-only read and is not this.
   */
  async findManyByIds(
    runner: TenantQueryRunner,
    context: TenantContext,
    clientOrganizationIds: readonly string[],
  ): Promise<readonly ClientOrganizationRow[]> {
    const unique = [...new Set(clientOrganizationIds)];
    if (unique.length === 0) return [];
    return tenantDrizzle(runner)
      .select()
      .from(clientOrganizations)
      .where(
        and(
          eq(clientOrganizations.organizationId, context.organizationId),
          inArray(clientOrganizations.id, unique),
        ),
      );
  }

  /**
   * Fetch one client organization by id, within the acting tenant.
   *
   * There is deliberately no `findById(id)` without a context. On MySQL such a method returns
   * another customer's client list, which is the whole reason ADR-0001 exists.
   */
  async findById(
    runner: TenantQueryRunner,
    context: TenantContext,
    clientOrganizationId: string,
  ): Promise<ClientOrganizationRow | null> {
    const rows = await tenantDrizzle(runner)
      .select()
      .from(clientOrganizations)
      .where(
        and(
          eq(clientOrganizations.organizationId, context.organizationId),
          eq(clientOrganizations.id, clientOrganizationId),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  async requireById(
    runner: TenantQueryRunner,
    context: TenantContext,
    clientOrganizationId: string,
  ): Promise<ClientOrganizationRow> {
    const found = await this.findById(runner, context, clientOrganizationId);
    if (!found) throw new ClientOrganizationNotFoundError(clientOrganizationId);
    return found;
  }

  /**
   * Create a client organization.
   *
   * The id is generated here rather than by the database: `07-DATA-MODEL` fixes
   * application-generated UUIDv7 stored as canonical lowercase `CHAR(36)`, which lets a
   * command know the id before the insert commits — necessary for writing the outbox event
   * and the audit event in the same transaction (spec §3 step 8).
   *
   * There is no uniqueness constraint on `name`, and that is the schema's decision rather than
   * an omission here: two client companies with the same trading name are ordinary, and a
   * unique index would turn that into a failed onboarding with nothing the operator could do
   * about it.
   */
  async create(
    runner: TenantQueryRunner,
    context: TenantContext,
    input: CreateClientOrganizationInput,
  ): Promise<ClientOrganizationRow> {
    const id = uuidv7();

    await tenantDrizzle(runner)
      .insert(clientOrganizations)
      .values({
        id,
        // From the context. Not from `input` — there is no such field.
        organizationId: context.organizationId,
        name: input.name,
        createdAt: sql`current_timestamp(3)`,
        updatedAt: sql`current_timestamp(3)`,
      });

    // Read back rather than reconstruct: the row now carries server-generated timestamps, and
    // returning a hand-assembled object would let the two disagree.
    return this.requireById(runner, context, id);
  }

  /** Update a client organization, refusing a stale write. */
  async update(
    runner: TenantQueryRunner,
    context: TenantContext,
    clientOrganizationId: string,
    expectedUpdatedAt: Date,
    input: UpdateClientOrganizationInput,
  ): Promise<ClientOrganizationRow> {
    const changes: Record<string, unknown> = { updatedAt: sql`current_timestamp(3)` };
    if (input.name !== undefined) changes['name'] = input.name;

    const result = await tenantDrizzle(runner)
      .update(clientOrganizations)
      .set(changes)
      .where(
        and(
          eq(clientOrganizations.organizationId, context.organizationId),
          eq(clientOrganizations.id, clientOrganizationId),
          eq(clientOrganizations.updatedAt, expectedUpdatedAt),
        ),
      );

    if (result[0].affectedRows === 0) {
      // Zero rows means one of three things: wrong tenant, no such row, or a stale token.
      // They are distinguished by a scoped read, so a caller in the wrong tenant still gets
      // "not found" rather than a conflict that confirms the row exists.
      const current = await this.findById(runner, context, clientOrganizationId);
      if (!current) throw new ClientOrganizationNotFoundError(clientOrganizationId);
      throw new ClientOrganizationVersionConflictError(
        clientOrganizationId,
        current.updatedAt.getTime(),
      );
    }

    return this.requireById(runner, context, clientOrganizationId);
  }

  /**
   * Archive a client organization. There is no hard delete.
   *
   * `04-SECURITY-PRIVACY` and the offboarding lifecycle both treat removal as a state, not an
   * erasure: approvals, deliverables, client requests and audit events reference this row, and
   * a `DELETE` would either orphan them or cascade through them.
   *
   * **Archiving here does not revoke access.** The client memberships that hang off this row
   * keep their own `status` and `expires_at`, and the membership resolver reads those. Ending
   * a client relationship is therefore two acts, not one, and the second is
   * `ClientMembershipsRepository.transitionStatus(..., 'offboarded')` for each member — see
   * that repository's note on why offboarding is not something a parent row can imply.
   */
  async archive(
    runner: TenantQueryRunner,
    context: TenantContext,
    clientOrganizationId: string,
  ): Promise<ClientOrganizationRow> {
    const result = await tenantDrizzle(runner)
      .update(clientOrganizations)
      .set({ archivedAt: sql`current_timestamp(3)`, updatedAt: sql`current_timestamp(3)` })
      .where(
        and(
          eq(clientOrganizations.organizationId, context.organizationId),
          eq(clientOrganizations.id, clientOrganizationId),
          isNull(clientOrganizations.archivedAt),
        ),
      );

    if (result[0].affectedRows === 0) {
      const current = await this.findById(runner, context, clientOrganizationId);
      if (!current) throw new ClientOrganizationNotFoundError(clientOrganizationId);
      return current; // Already archived; archiving twice is not an error.
    }

    return this.requireById(runner, context, clientOrganizationId);
  }
}
