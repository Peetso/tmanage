import type { Principal } from '@tmanage/domain';
import type { TenantContext, TenantDatabase } from '../../../common/database/tenant-context.js';
import { ApiError } from '../../../common/http/errors.js';
import type { ApiErrorCode } from '../../../common/http/errors.js';
import { bindAuditOrigin, requestOriginOf } from '../../../common/http/request-origin.js';
import type { SupportSessionStamp } from '../../../common/http/request-origin.js';
import {
  MembershipNotResolvedError,
  type MembershipResolver,
  type ResolvedMembership,
} from '../../tenancy/membership-resolver.repository.js';
import type { PrincipalRepository } from '../../tenancy/principal.repository.js';
import { requireId } from '../platform-admin.access.js';
import type { PlatformAdminActor } from '../platform-admin.guard.js';

/**
 * platform-admin v2 · PA-08 — the Support path of the content browser (SPEC P2, §5.4).
 *
 * Every content call (reads included: reading a customer's chats IS access) runs under the tenant
 * context of the admin's hidden `platform_support` membership in that one organization — the
 * ordinary resolver path, so the tenant guard, the composite keys and the grants apply unchanged.
 * There is no second way in: without a live Support session the resolver refuses the hidden row
 * (PA-01) and this answers **428 `support_session_required`**, which the screen turns into the
 * "Open a support session" prompt (frame 436:17010) and then retries.
 *
 * An admin who is also an ordinary member of the organization is refused the same way: their own
 * membership is not a support visit, so nothing they read here would be stamped as support.
 */

/** The response code of the prompt (in the shared `ApiErrorCode` union); the web reads the 428 status. */
export const SUPPORT_SESSION_REQUIRED: ApiErrorCode = 'support_session_required';

export const SUPPORT_SESSION_REQUIRED_MESSAGE =
  'Open a support session for this organization to read or change its content';

export function supportSessionRequired(auditCode: string): ApiError {
  return new ApiError(
    428,
    SUPPORT_SESSION_REQUIRED,
    SUPPORT_SESSION_REQUIRED_MESSAGE,
    undefined,
    auditCode,
  );
}

/** What a content call acts under: one organization, the hidden membership, its session. */
export interface SupportScope {
  readonly organizationId: string;
  /** The hidden membership's context, bound to this request's IP, device and support session. */
  readonly context: TenantContext;
  readonly principal: Principal;
  readonly session: SupportSessionStamp & { readonly expiresAt: Date };
}

export interface SupportRequest {
  readonly correlationId: string;
  /** The HTTP request, for the IP and device stamped on every audit row. */
  readonly request: object;
}

export class SupportContextResolver {
  constructor(
    private readonly database: TenantDatabase,
    private readonly resolver: Pick<MembershipResolver, 'resolve'>,
    private readonly principals: Pick<PrincipalRepository, 'load'>,
  ) {}

  async resolve(
    actor: PlatformAdminActor,
    organizationIdRaw: string,
    request: SupportRequest,
  ): Promise<SupportScope> {
    const organizationId = requireId(organizationIdRaw);
    let resolved: ResolvedMembership;
    try {
      resolved = await this.resolver.resolve({
        userId: actor.account.userId,
        organization: { organizationId },
        correlationId: request.correlationId,
      });
    } catch (error) {
      if (error instanceof MembershipNotResolvedError) {
        throw supportSessionRequired(`no_live_support_session:${error.code}`);
      }
      throw error;
    }
    const live = resolved.supportSession ?? null;
    if (live === null || live.adminUserId !== actor.account.userId) {
      throw supportSessionRequired('membership_is_not_a_support_visit');
    }
    const session = { id: live.id, adminUserId: live.adminUserId, expiresAt: live.expiresAt };
    const context = bindAuditOrigin(resolved.context, {
      ...requestOriginOf(request.request),
      supportSession: session,
    });
    const principal = await this.database.read(context, (runner) =>
      this.principals.load(runner, resolved),
    );
    return { organizationId, context, principal, session };
  }
}
