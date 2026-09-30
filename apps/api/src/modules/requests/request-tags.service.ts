import { authorize } from '@tmanage/domain';
import type { Principal } from '@tmanage/domain';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import type {
  TenantContext,
  TenantDatabase,
  TenantQueryRunner,
} from '../../common/database/tenant-context.js';
import type { ClientRequestRow, RequestTagRow } from '../../common/database/schema.js';
import { ClientRequestsRepository } from './client-requests.repository.js';
import { RequestTagsRepository } from './request-tags.repository.js';

/**
 * x316's application service — free-text triage labels on a client request (Requests module 11).
 *
 * The two rules that matter live here, the way `WorkLabelsService` places them:
 *
 * ## Resolve the request, tenant-scoped, BEFORE authorizing or writing
 *
 * Every route names a `clientRequestId` in the path; the parent request is read first, scoped to the
 * acting tenant — a cross-tenant `client_request_id` simply does not resolve, and the answer is the
 * same 404 an absent id gives, before `authorize()` is ever asked and before any write. Only then is
 * `client_request.triage` checked against the resolved request (internal-only; a client never holds
 * it, and a project-scoped manager may triage only their own projects' requests).
 *
 * ## Tags are free text, added and removed, never amended
 *
 * A label is a non-empty string of at most 120 characters (anything else is a 400, no insert). A
 * request carries a label only once — a duplicate (case-insensitively, by the 0184 collation) is a
 * 409, no second row. Removal of a tag that is not present is a no-op 204.
 */

/** The maximum length of a tag label, matching the `VARCHAR(120)` column. */
export const MAX_REQUEST_TAG_LABEL = 120;

export class RequestTagsService {
  constructor(
    private readonly database: TenantDatabase,
    private readonly requests: ClientRequestsRepository = new ClientRequestsRepository(),
    private readonly tags: RequestTagsRepository = new RequestTagsRepository(),
  ) {}

  /** The tags on a client request, label-ascending. Behind `client_request.triage` on the parent. */
  async listForRequest(
    context: TenantContext,
    principal: Principal,
    clientRequestId: string,
  ): Promise<readonly RequestTagRow[]> {
    return this.database.read(context, async (runner) => {
      await this.triageableRequest(runner, context, principal, clientRequestId);
      return this.tags.listForRequest(runner, context, clientRequestId);
    });
  }

  /**
   * Tag a request with a free-text label. Behind `client_request.triage`. Cross-tenant / unknown
   * request → 404 (no write); empty or over-length label → 400 (no write); a label already on the
   * request → 409 (no second row).
   */
  async addTag(
    context: TenantContext,
    principal: Principal,
    clientRequestId: string,
    rawLabel: unknown,
  ): Promise<RequestTagRow> {
    const label = requiredLabel(rawLabel);
    return this.database.transaction(context, async (tx) => {
      await this.triageableRequest(tx, context, principal, clientRequestId);

      const clash = await this.tags.findByLabel(tx, context, clientRequestId, label);
      if (clash) {
        throw new ApiError(409, 'conflict', 'This label is already on the request');
      }
      return this.tags.create(tx, context, {
        clientRequestId,
        label,
        createdBy: principal.userId,
      });
    });
  }

  /** Untag a request. Behind `client_request.triage`. A tag that is not present is a no-op 204. */
  async removeTag(
    context: TenantContext,
    principal: Principal,
    clientRequestId: string,
    tagId: string,
  ): Promise<void> {
    await this.database.transaction(context, async (tx) => {
      await this.triageableRequest(tx, context, principal, clientRequestId);
      await this.tags.deleteById(tx, context, clientRequestId, tagId);
    });
  }

  /**
   * Resolve the parent client request, tenant-scoped, and refuse a caller who may not triage it. The
   * 404 for a cross-tenant or absent id is produced here — before `authorize()` and before any write
   * — and is the same 404 an unknown id gives, so a foreign request id never leaks its existence. A
   * caller who can see the tenant but lacks `client_request.triage` for this request gets a 403.
   */
  private async triageableRequest(
    runner: TenantQueryRunner,
    context: TenantContext,
    principal: Principal,
    clientRequestId: string,
  ): Promise<ClientRequestRow> {
    const row = await this.requests.findById(runner, context, clientRequestId);
    if (!row) {
      throw new ApiError(404, 'not_found', MESSAGES.notFound);
    }
    const verdict = authorize({
      principal,
      capability: 'client_request.triage',
      resource: {
        organizationId: row.organizationId,
        projectId: row.projectId,
        clientOrganizationId: row.clientOrganizationId,
        audience: 'internal',
        lifecycle: 'active',
      },
    });
    if (!verdict.allowed) {
      throw new ApiError(403, 'forbidden', MESSAGES.forbidden, undefined, verdict.code);
    }
    return row;
  }
}

function requiredLabel(raw: unknown): string {
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new ApiError(400, 'validation_failed', 'The request body is invalid', [
      { field: 'label', message: 'must be a non-empty string' },
    ]);
  }
  const label = raw.trim();
  if (label.length > MAX_REQUEST_TAG_LABEL) {
    throw new ApiError(400, 'validation_failed', 'The request body is invalid', [
      { field: 'label', message: `must be ${MAX_REQUEST_TAG_LABEL} characters or fewer` },
    ]);
  }
  return label;
}
