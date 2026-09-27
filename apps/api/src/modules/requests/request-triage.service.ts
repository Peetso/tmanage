import { authorize } from '@tmanage/domain';
import type { Principal } from '@tmanage/domain';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { RequestTriageRepository, TriagedRequestRow } from './request-triage.repository.js';
import type { RequestTriageView } from './request-triage.controller.js';

/**
 * Request triage service — the studio's internal triage of an incoming client request (REQ-02, x265).
 *
 * It owns the order the brief fixes and the sibling reads keep: **resolve the request (and, when
 * named, the assignee) tenant-scoped BEFORE authorize**, so a request that does not exist in this
 * studio is a 404 rather than a 403 that would confirm it exists elsewhere, and an assignee who is
 * not an active member here is a 404 rather than a foreign-key error at the write. Only once both
 * resolve does the relation-scoped `authorize()` run: `client_request.triage` is relation-gated, so a
 * project-scoped manager may triage only their own projects' requests — the coarse capability guard
 * on the route is UX, and this object-level check is the real ceiling. The category allowlist is the
 * controller's (a malformed body is a 400 before any of this runs); this service never writes an
 * unresolved, unauthorised, or cross-tenant triage.
 */
export class RequestTriageService {
  constructor(
    private readonly database: TenantDatabase,
    private readonly triage: RequestTriageRepository,
  ) {}

  /** The current triage for a request, or a null-category view when it has not been triaged yet. */
  async getTriage(
    context: TenantContext,
    principal: Principal,
    requestId: string,
  ): Promise<RequestTriageView> {
    return this.database.read(context, async (runner) => {
      const request = await this.triage.findRequest(runner, context, requestId);
      if (!request) throw notFound();
      this.assertMayTriage(principal, request);

      const row = await this.triage.findTriage(runner, context, requestId);
      return {
        requestId,
        category: row?.category ?? null,
        assigneeMembershipId: row?.assigneeMembershipId ?? null,
        triaged: row !== null,
      };
    });
  }

  /**
   * File or replace the triage for a request. Resolves the request and the assignee before the
   * relation check, then upserts the validated category and assignee. Returns the stored triage.
   */
  async setTriage(
    context: TenantContext,
    principal: Principal,
    requestId: string,
    input: { category: string; assigneeMembershipId: string | null },
  ): Promise<RequestTriageView> {
    return this.database.transaction(context, async (tx) => {
      const request = await this.triage.findRequest(tx, context, requestId);
      if (!request) throw notFound();

      if (input.assigneeMembershipId !== null) {
        const resolved = await this.triage.findActiveMembershipId(
          tx,
          context,
          input.assigneeMembershipId,
        );
        if (resolved === null) throw notFound();
      }

      this.assertMayTriage(principal, request);

      await this.triage.upsert(tx, context, requestId, input.category, input.assigneeMembershipId);
      const row = await this.triage.findTriage(tx, context, requestId);
      return {
        requestId,
        category: row?.category ?? input.category,
        assigneeMembershipId: row?.assigneeMembershipId ?? input.assigneeMembershipId,
        triaged: true,
      };
    });
  }

  /**
   * The relation-scoped ceiling: whether this principal may triage this particular request, judged by
   * `client_request.triage` against the request's own project. An internal role with org-wide or the
   * project's scope is allowed; a client is refused (the capability is internal-only), and a
   * cross-tenant principal by the tenant check inside `authorize`. A refusal is a 403.
   */
  private assertMayTriage(principal: Principal, request: TriagedRequestRow): void {
    const decision = authorize({
      principal,
      capability: 'client_request.triage',
      resource: {
        organizationId: request.organizationId,
        projectId: request.projectId,
        clientOrganizationId: request.clientOrganizationId,
        audience: 'internal',
        lifecycle: 'active',
      },
    });
    if (!decision.allowed) {
      throw new ApiError(403, 'forbidden', MESSAGES.forbidden, undefined, 'request_triage_denied');
    }
  }
}

/** The request is not this studio's (or does not exist): a 404, never a 403 that would confirm it. */
function notFound(): ApiError {
  return new ApiError(404, 'not_found', 'The client request was not found');
}
