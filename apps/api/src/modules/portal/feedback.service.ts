import { authorize } from '@tmanage/domain';
import type { Principal } from '@tmanage/domain';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import { ClientProjectionsRepository } from '../approvals/client-projections.repository.js';
import { PortalFeedbackRepository } from './feedback.repository.js';

/**
 * Portal deliverable feedback — x321 (module 13, Client Portal).
 *
 * A client contact leaves a rating (1–5) and optional comment on a *published* deliverable, and
 * staff read the feedback for a deliverable. It is the first client *write* the portal makes onto a
 * deliverable, and it is built the way every client-facing decision in this system is
 * (`ApprovalsService` is the precedent):
 *
 * ## Resolve tenant-scoped, then authorize the object — and every object refusal is 404
 *
 * The route names a deliverable by id. The client-visible version is resolved **tenant-scoped
 * first** through the x114 projection (`findLatestByDeliverable`): a deliverable with no published
 * projection — unknown id, cross-tenant id, or one never published — is absent, which is a `404`
 * here, so an unpublished deliverable a client must not learn exists cannot be written to. Only then
 * is the projection's project run through `authorize()` at audience `client_visible`. **Every**
 * object-level refusal — off-client, wrong tenant, not published — is the same `404, not 403`: a
 * client probing deliverable ids must not learn which of them are real. The coarse "does this role
 * hold `client_projection.read` at all?" gate is the route's `@RequireCapability`, which is where a
 * 403 comes from; this service never widens a scope refusal into one.
 *
 * ## No internal field is ever returned to the client
 *
 * The write returns only what the contact authored — their own rating, comment and timestamps —
 * built field by field, never the row spread. The staff read returns the authoring contact too,
 * because staff are entitled to know who left which rating; a client never reaches that path
 * (`client_member.manage` is denied to a client at audience `internal`).
 */

/** The client's own view of the feedback they left. No authoring id — it is themselves. */
export interface PortalFeedbackClientView {
  readonly id: string;
  readonly rating: number;
  readonly comment: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** One feedback as staff read it — the authoring contact is included. */
export interface PortalFeedbackStaffView {
  readonly id: string;
  readonly clientContactUserId: string;
  readonly rating: number;
  readonly comment: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface SubmitFeedbackInput {
  readonly rating: unknown;
  readonly comment?: unknown;
}

/** A comment is bounded so a client cannot write an unbounded blob into a `TEXT` column. */
const MAX_COMMENT_LENGTH = 4000;

export class PortalFeedbackService {
  constructor(
    private readonly database: TenantDatabase,
    private readonly projections: ClientProjectionsRepository = new ClientProjectionsRepository(),
    private readonly feedback: PortalFeedbackRepository = new PortalFeedbackRepository(),
  ) {}

  /**
   * A client contact leaves or revises feedback on a published deliverable — POST
   * `/portal/deliverables/:id/feedback`, `client_projection.read`.
   *
   * The order is the Known trap's and the refusals are the ones x321 exists to prove:
   *
   * 1. The client-visible version is resolved tenant-scoped (`findLatestByDeliverable`); a
   *    deliverable with no published projection is a **404**.
   * 2. `authorize()` at audience `client_visible`; an off-client or cross-tenant deliverable fails
   *    it and is a **404**, never a 403 that would confirm the deliverable is real.
   * 3. `client_visible` scope needs the caller's own client organization — an internal caller has
   *    none, so it is a **404** (the deliverable review surface is staff-only elsewhere).
   * 4. `rating` must be an integer 1–5, else **400** with no insert; `comment` is optional and
   *    bounded.
   *
   * The author is `context.userId`, never a body field, and the write is an upsert on
   * `(org, version, contact)`, so a second submit revises the contact's own feedback rather than
   * adding a row.
   */
  async submit(
    context: TenantContext,
    principal: Principal,
    deliverableId: string,
    input: SubmitFeedbackInput,
  ): Promise<PortalFeedbackClientView> {
    const clientOrganizationId = principal.clientOrganizationId;
    if (!clientOrganizationId) {
      // Client-audience write: an internal principal has no single client organization to scope to.
      throw new ApiError(404, 'not_found', MESSAGES.notFound);
    }

    const projection = await this.database.read(context, (runner) =>
      this.projections.findLatestByDeliverable(runner, context, deliverableId),
    );
    if (!projection || !this.mayRead(principal, projection.projectId)) {
      // 404, not 403 — unpublished, unknown, cross-tenant or another client's deliverable are
      // indistinguishable to a probing client.
      throw new ApiError(404, 'not_found', MESSAGES.notFound);
    }

    const rating = input.rating;
    if (typeof rating !== 'number' || !Number.isInteger(rating) || rating < 1 || rating > 5) {
      throw new ApiError(400, 'validation_failed', 'The request body is invalid', [
        { field: 'rating', message: 'must be an integer from 1 to 5' },
      ]);
    }

    const comment = this.parseComment(input.comment);

    const row = await this.database.transaction(context, (tx) =>
      this.feedback.upsert(tx, context, {
        deliverableVersionId: projection.deliverableVersionId,
        // The author is the session's user, never a body field.
        clientContactUserId: context.userId,
        rating,
        comment,
      }),
    );

    return {
      id: row.id,
      rating: row.rating,
      comment: row.comment,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  /**
   * The feedback left on a deliverable — GET `/portal/deliverables/:id/feedback`,
   * `client_member.manage` (staff).
   *
   * The version is resolved tenant-scoped first (a deliverable with no projection is a **404**), and
   * only then is `client_member.manage` authorized at audience `internal` — which denies any client
   * principal, so this staff read never leaks to the client side even though it shares the `/portal`
   * path. A staff caller lacking the capability is refused by the route's `@RequireCapability`
   * before this runs.
   */
  async listForDeliverable(
    context: TenantContext,
    principal: Principal,
    deliverableId: string,
  ): Promise<readonly PortalFeedbackStaffView[]> {
    const projection = await this.database.read(context, (runner) =>
      this.projections.findLatestByDeliverable(runner, context, deliverableId),
    );
    if (!projection) {
      throw new ApiError(404, 'not_found', MESSAGES.notFound);
    }

    const verdict = authorize({
      principal,
      capability: 'client_member.manage',
      resource: {
        organizationId: context.organizationId,
        projectId: projection.projectId,
        // Internal staff read: a client principal is denied here (audience_internal), so a client
        // admin can never read every contact's feedback.
        audience: 'internal',
        lifecycle: 'active',
      },
    });
    if (!verdict.allowed) {
      throw new ApiError(404, 'not_found', MESSAGES.notFound, undefined, verdict.code);
    }

    const rows = await this.database.read(context, (runner) =>
      this.feedback.listByVersion(runner, context, projection.deliverableVersionId),
    );
    return rows.map((row) => ({
      id: row.id,
      clientContactUserId: row.clientContactUserId,
      rating: row.rating,
      comment: row.comment,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    }));
  }

  private parseComment(raw: unknown): string | null {
    if (raw === undefined || raw === null) return null;
    if (typeof raw !== 'string') {
      throw new ApiError(400, 'validation_failed', 'The request body is invalid', [
        { field: 'comment', message: 'must be a string' },
      ]);
    }
    const trimmed = raw.trim();
    if (trimmed.length === 0) return null;
    if (trimmed.length > MAX_COMMENT_LENGTH) {
      throw new ApiError(400, 'validation_failed', 'The request body is invalid', [
        { field: 'comment', message: `must be at most ${MAX_COMMENT_LENGTH} characters` },
      ]);
    }
    return trimmed;
  }

  /**
   * May this principal read the client projection of this project? One `authorize()` at audience
   * `client_visible`, exactly as `PortalService.mayRead` — the audience the projection actually
   * has. For a client principal that is the same-client-org, project-relation rule.
   */
  private mayRead(principal: Principal, projectId: string): boolean {
    return authorize({
      principal,
      capability: 'client_projection.read',
      resource: {
        organizationId: principal.organizationId,
        projectId,
        audience: 'client_visible',
        clientOrganizationId: principal.clientOrganizationId,
        isPublished: true,
        lifecycle: 'active',
      },
    }).allowed;
  }
}
