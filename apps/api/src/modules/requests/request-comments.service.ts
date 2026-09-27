import { authorize } from '@tmanage/domain';
import type { Principal } from '@tmanage/domain';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import type {
  TenantContext,
  TenantDatabase,
  TenantQueryRunner,
} from '../../common/database/tenant-context.js';
import type { ClientRequestRow, RequestCommentRow } from '../../common/database/schema.js';
import type { ClientRequestsRepository } from './client-requests.repository.js';
import { RequestCommentsRepository, isTopLevel } from './request-comments.repository.js';

/**
 * x299's application service — a client request's internal comment thread (Requests module 11).
 *
 * `WorkCommentsService`'s shape at the requests aggregate: the repository stays free of policy, the
 * controller stays free of both, and the rules that matter live here.
 *
 * ## Resolve the request, tenant-scoped, BEFORE authorizing or writing
 *
 * Every route names a `requestId` in the path. The parent request is read first, scoped to the
 * acting tenant — a `request_id` from another studio simply does not resolve, and the answer is the
 * same 404 an absent id gives. Only once the row is in hand is `authorize()` asked whether this
 * principal may triage it, judged against the request's project. That order is the trap x299 was
 * briefed on: a cross-tenant request is a 404 with no write, never a comment created against another
 * studio's request.
 *
 * ## `client_request.triage` is the one gate, applied twice
 *
 * The route decorator refuses a principal who does not hold `client_request.triage` at all (a client
 * — it is internal-only — or a role without it) with a 403 before the method runs. Here the same
 * capability is re-checked against the resolved request's project, so a scoped manager may comment
 * only on requests in a project they own; a caller with the capability but no relation to this
 * request's project gets a 403. Comments are internal-only and never reach any client or portal read.
 *
 * ## One level of reply
 *
 * A `parentId` must resolve to a top-level comment of the same request, else the write is a 400 with
 * no insert: a cross-request or unknown parent, and a reply-to-a-reply, are both refused.
 */

/** The internal projection of one request comment. Paired in `e2e/contracts`. */
export interface RequestCommentView {
  readonly id: string;
  readonly requestId: string;
  readonly parentId: string | null;
  readonly authorMembershipId: string;
  readonly body: string;
  readonly createdAt: string;
}

export interface AddRequestCommentInput {
  readonly body: string;
  readonly parentId?: string;
}

export class RequestCommentsService {
  constructor(
    private readonly database: TenantDatabase,
    private readonly requests: ClientRequestsRepository,
    private readonly comments: RequestCommentsRepository = new RequestCommentsRepository(),
  ) {}

  /** The request's comments, created-at ascending. Behind `client_request.triage` on the request. */
  async list(
    context: TenantContext,
    principal: Principal,
    requestId: string,
  ): Promise<readonly RequestCommentView[]> {
    return this.database.read(context, async (runner) => {
      await this.triageableRequest(runner, context, principal, requestId);
      const rows = await this.comments.listForRequest(runner, context, requestId);
      return rows.map(toView);
    });
  }

  /** Append a comment (optionally a reply). Behind `client_request.triage` on the request. */
  async add(
    context: TenantContext,
    principal: Principal,
    requestId: string,
    input: AddRequestCommentInput,
  ): Promise<RequestCommentView> {
    return this.database.transaction(context, async (tx) => {
      await this.triageableRequest(tx, context, principal, requestId);

      // The author is the acting membership. A `client_request.triage` holder is always an internal
      // member of this studio, so a membership id is present; a principal without one could not have
      // passed the gate and there is no client author of an internal comment.
      const authorMembershipId = principal.membershipId;
      if (!authorMembershipId) {
        throw new ApiError(403, 'forbidden', MESSAGES.forbidden);
      }

      const parentId = await this.resolveParent(tx, context, requestId, input.parentId);

      const row = await this.comments.create(tx, context, {
        requestId,
        parentId,
        authorMembershipId,
        body: input.body,
      });
      return toView(row);
    });
  }

  /** Retract a comment (and its replies). Behind `client_request.triage` on the request. */
  async remove(
    context: TenantContext,
    principal: Principal,
    requestId: string,
    commentId: string,
  ): Promise<void> {
    await this.database.transaction(context, async (tx) => {
      await this.triageableRequest(tx, context, principal, requestId);
      const comment = await this.comments.findComment(tx, context, requestId, commentId);
      if (!comment) {
        // A comment of another request or tenant does not resolve here; the 404 is the same an
        // absent id gives, so a caller cannot discover a comment by trying to delete it.
        throw new ApiError(404, 'not_found', MESSAGES.notFound);
      }
      await this.comments.deleteWithReplies(tx, context, requestId, commentId);
    });
  }

  /**
   * Read the parent request, tenant-scoped, and refuse a caller who may not triage it. The 404 for
   * a cross-tenant (or absent) request is produced here, before any write, and is the same 404 the
   * request read gives — so a caller cannot discover a request by hanging a comment off it. A 403 is
   * for a principal who holds `client_request.triage` but has no relation to this request's project.
   */
  private async triageableRequest(
    runner: TenantQueryRunner,
    context: TenantContext,
    principal: Principal,
    requestId: string,
  ): Promise<ClientRequestRow> {
    const row = await this.requests.findById(runner, context, requestId);
    if (!row) {
      throw new ApiError(404, 'not_found', MESSAGES.notFound);
    }
    const verdict = authorize({
      principal,
      capability: 'client_request.triage',
      resource: {
        organizationId: row.organizationId,
        projectId: row.projectId,
        audience: 'internal',
        lifecycle: 'active',
      },
    });
    if (!verdict.allowed) {
      throw new ApiError(403, 'forbidden', MESSAGES.forbidden, undefined, verdict.code);
    }
    return row;
  }

  /**
   * Resolve an optional `parentId` to a top-level comment of the same request. A missing parentId is
   * a top-level comment (`null`). A parentId that names nothing in this request, or names a comment
   * that is itself a reply, is a 400 with no insert — one level of reply only.
   */
  private async resolveParent(
    runner: TenantQueryRunner,
    context: TenantContext,
    requestId: string,
    parentId: string | undefined,
  ): Promise<string | null> {
    if (parentId === undefined) return null;
    const parent = await this.comments.findComment(runner, context, requestId, parentId);
    if (!parent || !isTopLevel(parent)) {
      throw new ApiError(400, 'validation_failed', 'The parent comment is invalid', [
        { field: 'parentId', message: 'must be a top-level comment of this request' },
      ]);
    }
    return parent.id;
  }
}

function toView(row: RequestCommentRow): RequestCommentView {
  return {
    id: row.id,
    requestId: row.requestId,
    parentId: row.parentId,
    authorMembershipId: row.authorMembershipId,
    body: row.body,
    createdAt: row.createdAt.toISOString(),
  };
}
