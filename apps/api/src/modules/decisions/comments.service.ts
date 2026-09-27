import { authorize } from '@tmanage/domain';
import type { Principal } from '@tmanage/domain';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { DecisionCommentRow, DecisionRow } from '../../common/database/schema.js';
import { DecisionsRepository } from './decisions.repository.js';
import { DecisionCommentsRepository } from './comments.repository.js';

/**
 * x317's application service — an internal comment thread on a decision (Requests, decisions &
 * approvals: decision discussion; 22-SCREEN decision register).
 *
 * It is `DecisionsService`'s shape at a smaller scale: the repository stays free of policy, the
 * controller stays free of both, and the rules that matter live here.
 *
 * ## Resolve the decision, tenant-scoped, BEFORE authorizing
 *
 * Every route names a `decisionId` in the path. The parent decision is read first, scoped to the
 * acting tenant — a `decision_id` from another studio simply does not resolve, and the answer is a
 * 404 (its existence in another tenant is a secret). Only once the row is in hand is `authorize()`
 * asked whether this principal may act on it, judged against the decision's own project with
 * `work.read` — the same relation gate `DecisionsService` uses (decisions are internal). A caller
 * who resolves the decision within the tenant but is not related to its project (so lacks
 * `work.read` on it) gets a 403 with no write; a caller naming another tenant's id gets a 404.
 *
 * ## Comments are internal, and delete is author-only
 *
 * A `work.read` holder is an internal member of this studio, so a comment is authored by a
 * membership and never reaches a client surface. A member may delete only their own comment: the
 * author is compared to the acting membership before any delete, and another member's comment is a
 * 403 with no delete. Deleting a comment that does not exist (or was already deleted) is a no-op the
 * controller answers 204 either way — the delete is idempotent.
 */

/** What a caller is allowed to see of one decision comment. `organizationId` is deliberately absent. */
export interface DecisionCommentView {
  readonly id: string;
  readonly decisionId: string;
  readonly authorMembershipId: string;
  readonly body: string;
  readonly createdAt: string;
}

function toView(row: DecisionCommentRow): DecisionCommentView {
  return {
    id: row.id,
    decisionId: row.decisionId,
    authorMembershipId: row.authorMembershipId,
    body: row.body,
    createdAt: row.createdAt.toISOString(),
  };
}

export class DecisionCommentsService {
  constructor(
    private readonly database: TenantDatabase,
    private readonly decisions: DecisionsRepository = new DecisionsRepository(),
    private readonly comments: DecisionCommentsRepository = new DecisionCommentsRepository(),
  ) {}

  /** A decision's comments, created-at ascending. Behind `work.read` on the decision's project. */
  async list(
    context: TenantContext,
    principal: Principal,
    decisionId: string,
  ): Promise<readonly DecisionCommentView[]> {
    await this.resolveReadableDecision(context, principal, decisionId);
    const rows = await this.database.read(context, (runner) =>
      this.comments.listForDecision(runner, context, decisionId),
    );
    return rows.map(toView);
  }

  /** Append a comment. Behind `work.read`; the author is the acting membership. */
  async add(
    context: TenantContext,
    principal: Principal,
    decisionId: string,
    body: string,
  ): Promise<DecisionCommentView> {
    await this.resolveReadableDecision(context, principal, decisionId);
    const row = await this.database.transaction(context, (tx) =>
      this.comments.create(tx, context, {
        decisionId,
        authorMembershipId: context.membershipId,
        body,
      }),
    );
    return toView(row);
  }

  /**
   * Delete a comment — author-only, idempotent. Behind `work.read` on the decision.
   *
   * The decision is resolved and read-authorized first (404 cross-tenant, 403 no relation). A
   * comment that does not exist is a no-op (idempotent 204); one that exists but is not the caller's
   * is a 403 with no delete — the author check is the one place the "own comment only" rule is
   * written, backed by the tenant-and-author predicate in the repository delete.
   */
  async remove(
    context: TenantContext,
    principal: Principal,
    decisionId: string,
    commentId: string,
  ): Promise<void> {
    await this.resolveReadableDecision(context, principal, decisionId);

    const comment = await this.database.read(context, (runner) =>
      this.comments.findComment(runner, context, decisionId, commentId),
    );
    if (!comment) {
      // Idempotent: an absent (or already-deleted) comment is a no-op the controller answers 204.
      return;
    }
    if (comment.authorMembershipId !== context.membershipId) {
      throw new ApiError(403, 'forbidden', MESSAGES.forbidden);
    }

    await this.database.transaction(context, (tx) =>
      this.comments.deleteOwn(tx, context, decisionId, commentId, context.membershipId),
    );
  }

  /**
   * Resolve the decision tenant-scoped, then require `work.read` on its project. A missing or
   * cross-tenant id is a 404 (its existence elsewhere is a secret); a decision resolved within the
   * tenant that the caller is not related to is a 403 — the caller is authenticated in this tenant,
   * so the refusal is about permission, not existence.
   */
  private async resolveReadableDecision(
    context: TenantContext,
    principal: Principal,
    decisionId: string,
  ): Promise<DecisionRow> {
    const decision = await this.database.read(context, (runner) =>
      this.decisions.findById(runner, context, decisionId),
    );
    if (!decision) {
      throw new ApiError(404, 'not_found', MESSAGES.notFound, undefined, 'decision_not_visible');
    }

    const verdict = authorize({
      principal,
      capability: 'work.read',
      resource: {
        organizationId: decision.organizationId,
        projectId: decision.projectId,
        audience: 'internal',
        lifecycle: 'active',
      },
    });
    if (!verdict.allowed) {
      throw new ApiError(403, 'forbidden', MESSAGES.forbidden, undefined, verdict.code);
    }
    return decision;
  }
}
