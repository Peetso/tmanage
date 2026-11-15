import { and, desc, eq, isNotNull, notExists, sql } from 'drizzle-orm';
import { uuidv7 } from '@tmanage/domain';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import { clientProjections, deliverables } from '../../common/database/schema.js';
import type { ClientProjectionPayload, ClientProjectionRow } from '../../common/database/schema.js';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';

/**
 * FR-05's client-safe projection — the storage half of "publish freezes an immutable client view".
 *
 * `DeliverableVersionsRepository`'s shape: `TenantContext` is the scoping parameter, no
 * `organizationId` on any input, a scoped read returns another tenant's row as absent rather than
 * throwing. What differs is what immutability means here — a projection is written once and never
 * changed, so there is deliberately no `update` and no `delete`, and a second publish of the same
 * version is refused by the UNIQUE (organization_id, deliverable_version_id) in `0031`, surfaced
 * here as {@link ClientProjectionAlreadyExistsError}.
 */

/**
 * FIX6 item 8: the projection's deliverable is not deleted. Every projection read carries it, so
 * deleting a deliverable takes it out of the portal, the client's approval door and the client's
 * file reach at once, and restoring brings it back. Written as "no deleted deliverable row" (not
 * "a live row exists"): an approval-only projection (0211 fixtures, older approvals) has a
 * deliverable id without a `deliverables` row, and it stays readable.
 */
export function deliverableIsLive(runner: TenantQueryRunner) {
  return notExists(
    tenantDrizzle(runner)
      .select({ one: sql`1` })
      .from(deliverables)
      .where(
        and(
          eq(deliverables.organizationId, clientProjections.organizationId),
          eq(deliverables.id, clientProjections.deliverableId),
          isNotNull(deliverables.deletedAt),
        ),
      ),
  );
}

export class ClientProjectionNotFoundError extends Error {
  constructor(readonly deliverableVersionId: string) {
    // No organization id in the message, for the reason `ClientRequestNotFoundError` gives: the
    // not-found body must not confirm a row the caller may not see exists.
    super(`No client projection was found for deliverable version ${deliverableVersionId}`);
    this.name = 'ClientProjectionNotFoundError';
  }
}

export class ClientProjectionAlreadyExistsError extends Error {
  constructor(readonly deliverableVersionId: string) {
    super(`Deliverable version ${deliverableVersionId} has already been published to the client`);
    this.name = 'ClientProjectionAlreadyExistsError';
  }
}

/** What publishing supplies. `organizationId` comes from the context, never the input. */
export interface PublishClientProjectionInput {
  readonly projectId: string;
  readonly deliverableId: string;
  readonly deliverableVersionId: string;
  /** The governed version's own hash, captured by the service — never re-derived. */
  readonly contentHash: string;
  /** The client-safe allowlisted payload (12-PERMISSION-MATRIX §1). */
  readonly projection: ClientProjectionPayload;
  readonly publishedByUserId: string;
}

/** MySQL's duplicate-key error number, the append-only guard the UNIQUE key raises on re-publish. */
const ER_DUP_ENTRY = 1062;

/**
 * A duplicate-key violation, seen through whatever wraps it.
 *
 * The `mysql2` driver raises `{ errno: 1062, code: 'ER_DUP_ENTRY' }`, but Drizzle re-throws it
 * wrapped, carrying the original on `.cause`, so the marker can be one level down. This inspects
 * the error and its cause for either the numeric `errno` or the string `code`.
 */
function isDuplicateKeyError(error: unknown): boolean {
  const marks = (candidate: unknown): boolean =>
    typeof candidate === 'object' &&
    candidate !== null &&
    ((candidate as { errno?: number }).errno === ER_DUP_ENTRY ||
      (candidate as { code?: string }).code === 'ER_DUP_ENTRY');
  if (marks(error)) return true;
  return typeof error === 'object' && error !== null && marks((error as { cause?: unknown }).cause);
}

export class ClientProjectionsRepository {
  /**
   * Freeze a governed version into its immutable client projection.
   *
   * Append-only: the UNIQUE (organization_id, deliverable_version_id) in `0031` refuses a second
   * projection of the same version, and that duplicate-key error is translated to a typed
   * {@link ClientProjectionAlreadyExistsError} the service maps to 409 — the same rule at the
   * engine as in the application, so a concurrent double-publish cannot both win.
   */
  async publish(
    runner: TenantQueryRunner,
    context: TenantContext,
    input: PublishClientProjectionInput,
  ): Promise<ClientProjectionRow> {
    const id = uuidv7();
    try {
      await tenantDrizzle(runner).insert(clientProjections).values({
        id,
        organizationId: context.organizationId,
        projectId: input.projectId,
        deliverableId: input.deliverableId,
        deliverableVersionId: input.deliverableVersionId,
        contentHash: input.contentHash,
        projection: input.projection,
        publishedByUserId: input.publishedByUserId,
        publishedAt: new Date(),
      });
    } catch (error) {
      if (isDuplicateKeyError(error)) {
        throw new ClientProjectionAlreadyExistsError(input.deliverableVersionId);
      }
      throw error;
    }
    return this.requireByVersion(runner, context, input.deliverableVersionId);
  }

  async findByVersion(
    runner: TenantQueryRunner,
    context: TenantContext,
    deliverableVersionId: string,
  ): Promise<ClientProjectionRow | null> {
    const rows = await tenantDrizzle(runner)
      .select()
      .from(clientProjections)
      .where(
        and(
          eq(clientProjections.organizationId, context.organizationId),
          eq(clientProjections.deliverableVersionId, deliverableVersionId),
          deliverableIsLive(runner),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  async requireByVersion(
    runner: TenantQueryRunner,
    context: TenantContext,
    deliverableVersionId: string,
  ): Promise<ClientProjectionRow> {
    const found = await this.findByVersion(runner, context, deliverableVersionId);
    if (!found) throw new ClientProjectionNotFoundError(deliverableVersionId);
    return found;
  }

  /**
   * x114. Every published projection in one project, newest first — the client portal's
   * deliverables read.
   *
   * Scoped by `context.organizationId`; a projection in another tenant is absent, never an
   * error, exactly as {@link findByVersion} is. One row per *published version*, because a
   * projection is frozen per version (`0031`), and that is what the client is meant to review.
   * `publishedAt DESC, id DESC` gives a deterministic newest-first order the screen can page on.
   * There is no relation predicate here — the caller checks `authorize()` per project before it
   * asks, the same division of labour {@link PortalService} keeps for projects and work items.
   */
  async listByProject(
    runner: TenantQueryRunner,
    context: TenantContext,
    projectId: string,
  ): Promise<readonly ClientProjectionRow[]> {
    return tenantDrizzle(runner)
      .select()
      .from(clientProjections)
      .where(
        and(
          eq(clientProjections.organizationId, context.organizationId),
          eq(clientProjections.projectId, projectId),
          deliverableIsLive(runner),
        ),
      )
      .orderBy(desc(clientProjections.publishedAt), desc(clientProjections.id));
  }

  /**
   * x114. The most recently published projection of one deliverable, or null — how the portal
   * resolves a `deliverableId` to the project it lives in *tenant-scoped* before the relation
   * check (FAST-PROTOCOL Known trap). A deliverable with no projection is an unpublished
   * deliverable a client must not learn exists, so the caller maps null to 404.
   */
  async findLatestByDeliverable(
    runner: TenantQueryRunner,
    context: TenantContext,
    deliverableId: string,
  ): Promise<ClientProjectionRow | null> {
    const rows = await tenantDrizzle(runner)
      .select()
      .from(clientProjections)
      .where(
        and(
          eq(clientProjections.organizationId, context.organizationId),
          eq(clientProjections.deliverableId, deliverableId),
          deliverableIsLive(runner),
        ),
      )
      .orderBy(desc(clientProjections.publishedAt), desc(clientProjections.id))
      .limit(1);
    return rows[0] ?? null;
  }
}
