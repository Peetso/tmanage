import { Inject, Injectable, Optional } from '@nestjs/common';
import type { CanActivate, ExecutionContext } from '@nestjs/common';
import { ModuleRef, Reflector } from '@nestjs/core';
import { ApiError, MESSAGES } from '../errors.js';
import { SKIPS_TENANT, IS_PUBLIC } from '../decorators.js';
import { isBoundTokenScheme, requireRequestState } from '../request-state.js';
import type { RequestState } from '../request-state.js';
import {
  MEMBERSHIP_RESOLVER,
  PRINCIPAL_REPOSITORY,
  SESSION_SERVICE,
  TENANT_DATABASE,
} from '../tokens.js';
import { boundTokenAllowedOnNoTenantRoute } from './bound-token-allowlist.js';
import type { TenantContext, TenantQueryRunner } from '../../database/tenant-context.js';
import {
  AI_ACCESS_SWITCHES,
  aiPlatformDisabledError,
  aiWorkspaceDisabledError,
  createAiAccessSwitches,
  environmentAiDisabled,
} from '../../../modules/oauth/ai-access.js';
import type { AiAccessSwitches } from '../../../modules/oauth/ai-access.js';
import { normalizePolicy } from '../../../modules/admin/policies.allowlist.js';
import { PoliciesRepository } from '../../../modules/admin/policies.repository.js';
import type { SessionService } from '../../../modules/identity/session.service.js';
import { SessionsRepository } from '../../../modules/identity/sessions.repository.js';

/** Substitutes the guard's policy checks in a test. Never provided in production. */
export const TENANT_GUARD_CHECKS = Symbol.for('tmanage.TenantGuardChecks');

/** What `TenantContextGuard` consults beyond membership (F10, F52a). */
export interface TenantGuardChecks {
  readonly aiSwitches: AiAccessSwitches;
  /**
   * The `session_max_hours` in force for the acting company: its stored value, or the default when it
   * stored no policy. `null` (no limit) only from a substituted test check.
   */
  sessionMaxHours(runner: TenantQueryRunner, context: TenantContext): Promise<number | null>;
  /** Was this session started more than `hours` ago, by the database clock? */
  sessionOlderThan(sessionId: string, hours: number, correlationId: string): Promise<boolean>;
  /** End the session, so its refresh token stops working too. */
  endSession(sessionId: string, correlationId: string): Promise<void>;
}
import {
  MembershipNotResolvedError,
  SUSPENDED_MESSAGE,
} from '../../../modules/tenancy/membership-resolver.repository.js';
import type { MembershipResolver } from '../../../modules/tenancy/membership-resolver.repository.js';
import type { PrincipalRepository } from '../../../modules/tenancy/principal.repository.js';
import type { TenantDatabase } from '../../database/tenant-context.js';
import { withActorChannel } from '../../database/tenant-context.js';
import { bindAuditOrigin, requestOriginOf } from '../request-origin.js';
import type { SupportSessionStamp } from '../request-origin.js';

/**
 * Spec §3 steps 2 to 4 — resolve the organization, build the context, load the policy facts.
 *
 * This is the guard that turns a URL segment into authority, so it is the one place where
 * getting the direction of trust backwards would undo the whole access layer. §2 states the
 * rule it implements:
 *
 *   "The organization slug/ID from the route is accepted only after the API confirms an active
 *    internal or client membership."
 *
 * So `params.orgSlug` is passed to `MembershipResolver.resolve()` as a **claim under test**,
 * and what comes back is bound to the organization the membership row proves. The slug is
 * never written into a `TenantContext` directly, and nothing downstream reads it again.
 *
 * ## Why a failure is 404 and not 403
 *
 * `MembershipNotResolvedError` covers both "no such organization" and "you are not in it", by
 * design — it carries one message for every cause. Rendering that as 403 would reintroduce at
 * the HTTP layer exactly the distinction the resolver refuses to make, because a 403 confirms
 * the organization exists. Slugs are company names and therefore guessable, so that would be a
 * customer-enumeration oracle for anyone holding any valid session.
 *
 * 404 with a fixed message keeps the two indistinguishable. The database suite asserts the
 * response to a real-but-unreachable slug is **byte-identical** to the response for a slug
 * that does not exist.
 *
 * ## Step 4 runs on the scoped path
 *
 * The resolver waives ADR-0001 layer 3 because it is what establishes the tenant. Nothing
 * after it does. `PrincipalRepository.load()` is therefore called inside an ordinary
 * `TenantDatabase.read()` bound to the freshly-built context, and a test asserts a whole
 * authenticated request emits no guard event at all — which is what keeps the waiver one read
 * rather than a mode the request stays in.
 */
@Injectable()
export class TenantContextGuard implements CanActivate {
  /** The production checks, built on first use when Nest constructed this guard. */
  private builtChecks: TenantGuardChecks | undefined;

  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(MEMBERSHIP_RESOLVER) private readonly resolver: MembershipResolver,
    @Inject(PRINCIPAL_REPOSITORY) private readonly principals: PrincipalRepository,
    @Inject(TENANT_DATABASE) private readonly database: TenantDatabase,
    /** A test substitutes the checks here; production builds them (see `checks()`). */
    @Optional()
    @Inject(TENANT_GUARD_CHECKS)
    private readonly injectedChecks?: TenantGuardChecks,
    @Optional() @Inject(ModuleRef) private readonly moduleRef?: ModuleRef,
    @Optional()
    @Inject(SESSION_SERVICE)
    private readonly sessionService?: Pick<SessionService, 'revoke'>,
  ) {}

  /**
   * The AI switches (F10) and the session-lifetime policy (F52a). When Nest builds the guard it
   * always has a `ModuleRef`, so production always gets the real checks: the AI switches shared
   * from the module that provides them (or built over the same database, fail-closed), the
   * stored company policy and the session row. Only a guard constructed by hand with neither — a
   * unit test of the membership rules — runs without them.
   */
  private checks(): TenantGuardChecks | undefined {
    if (this.injectedChecks !== undefined) return this.injectedChecks;
    if (this.moduleRef === undefined) return undefined;
    this.builtChecks ??= createTenantGuardChecks(
      this.database,
      resolveAiSwitches(this.moduleRef, this.database),
      this.sessionService,
    );
    return this.builtChecks;
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const skip = this.reflector.getAllAndOverride<boolean>(SKIPS_TENANT, [
      context.getHandler(),
      context.getClass(),
    ]);
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const request = context.switchToHttp().getRequest<{
      readonly params: Record<string, string | undefined>;
    }>();
    const state = requireRequestState(request);

    if (skip) {
      // F01 part b. A `@NoTenant()` route is about the person, not the company, so an org-bound
      // token (PAT, OAuth token, internal grant) is refused on all of them except the few the AI
      // connector needs (`bound-token-allowlist.ts`). A cookie session is unaffected.
      if (isBoundTokenScheme(state.authScheme)) {
        if (!boundTokenAllowedOnNoTenantRoute(this.reflector, context)) {
          throw new ApiError(
            403,
            'forbidden',
            MESSAGES.forbidden,
            undefined,
            'bound_token_not_allowed',
          );
        }
        await this.enforceAiSwitches(state);
      }
      return true;
    }

    const session = state.session;
    if (!session) {
      throw new ApiError(401, 'unauthenticated', MESSAGES.unauthenticated, undefined, 'no_session');
    }

    const slug = request.params['orgSlug'];
    if (!slug) {
      // A tenant-scoped route with no `:orgSlug` segment is a routing mistake, and it must not
      // degrade into "resolve nothing and continue without a tenant".
      throw new Error(
        'TenantContextGuard ran on a route with no :orgSlug parameter. Mark it @NoTenant() if ' +
          'it is genuinely not tenant-scoped.',
      );
    }

    let resolved;
    try {
      resolved = await this.resolver.resolve({
        userId: session.userId,
        organization: { slug },
        correlationId: state.correlationId,
      });
    } catch (error) {
      if (error instanceof MembershipNotResolvedError) {
        // 0206. A proved member of a suspended company is told so (403) instead of the 404 —
        // the resolver raises this only after the membership row matched, so no outsider sees it.
        if (error.code === 'organization_suspended') {
          throw new ApiError(403, 'forbidden', SUSPENDED_MESSAGE, undefined, error.code);
        }
        throw new ApiError(404, 'not_found', MESSAGES.organizationNotFound, undefined, error.code);
      }
      throw error;
    }

    // A personal access token may act only in the organization it was created in (0202). The
    // resolver has just proved the member belongs to the requested org, but a token is bound to
    // ONE org, not to every org its member is in — so a resolved org that is not the token's is
    // refused here, before any principal is loaded. The refusal is the same 404 (and the same
    // fixed `organizationNotFound` body) a non-member or unknown-slug attempt gets, so a token
    // cannot distinguish "that org is not yours" from "that org does not exist"; the specific
    // cause travels to the log on the audit code, exactly as `MembershipNotResolvedError` does.
    const patBinding = state.personalAccessToken;
    if (
      isBoundTokenScheme(state.authScheme) &&
      patBinding !== undefined &&
      resolved.context.organizationId !== patBinding.organizationId
    ) {
      throw new ApiError(
        404,
        'not_found',
        MESSAGES.organizationNotFound,
        undefined,
        'token_organization_mismatch',
      );
    }

    // F10. A bound token is an AI app's key: the owner's "Allow AI apps" switch and the operator's
    // platform switch stop it on REST exactly as they stop it on `/mcp`.
    if (isBoundTokenScheme(state.authScheme)) await this.enforceAiSwitches(state);

    const checks = state.authScheme === 'cookie' ? this.checks() : undefined;
    const loaded = await this.database.read(resolved.context, async (runner) => ({
      principal: await this.principals.load(runner, resolved),
      // F52a. Read on the same scoped connection as the principal: no extra pool slot.
      sessionMaxHours:
        checks === undefined ? null : await checks.sessionMaxHours(runner, resolved.context),
    }));

    // F52a. The company's "session lifetime" policy: a cookie session older than it is ended and
    // the person signs in again. Sessions are user-level, so it is enforced where the company is
    // known; a company that stored no policy gets the default lifetime (wave 10 R5).
    if (checks !== undefined && loaded.sessionMaxHours !== null) {
      const tooOld = await checks.sessionOlderThan(
        session.sessionId,
        loaded.sessionMaxHours,
        state.correlationId,
      );
      if (tooOld) {
        await checks.endSession(session.sessionId, state.correlationId);
        throw new ApiError(
          401,
          'unauthenticated',
          MESSAGES.unauthenticated,
          undefined,
          'reauth_required:org_session_max_hours',
        );
      }
    }
    state.membership = resolved;
    // AUT-08. A personal access token, and the MCP connector's internal grant (S6), are the
    // AI-assistant / MCP channel, so tag the context the services will act under; the audit append
    // stamps it onto the metadata it writes, and the item's activity feed reads that back as "via
    // AI assistant". A cookie session is untagged, leaving its context — and every audit row it
    // writes — exactly as before.
    const channelled = isBoundTokenScheme(state.authScheme)
      ? withActorChannel(resolved.context, 'ai_assistant', state.aiGrant?.clientName)
      : resolved.context;
    // Platform admin v2 (PA-02). The support session the resolver found for this membership (a
    // hidden `platform_support` row; PA-01's resolver field, read optionally), plus the request's
    // IP and device, travel beside a per-request copy of the context so every audit row this
    // request writes is stamped with them (`request-origin.ts`).
    const supportSession = supportSessionFromResolved(resolved);
    SUPPORT_SESSIONS.set(request, supportSession);
    state.tenant = bindAuditOrigin(channelled, { ...requestOriginOf(request), supportSession });
    state.principal = loaded.principal;

    return true;
  }

  /**
   * F10. For a bound token: the platform switch off is 503 `ai_access_disabled`, the token's
   * workspace switch off is 403 `ai_disabled` — the same answers the hosted `/mcp` gives.
   */
  private async enforceAiSwitches(state: RequestState): Promise<void> {
    const checks = this.checks();
    if (checks === undefined) return;
    if (!(await checks.aiSwitches.platformOn(state.correlationId))) {
      throw aiPlatformDisabledError();
    }
    const binding = state.personalAccessToken;
    if (
      binding !== undefined &&
      !(await checks.aiSwitches.organizationOn(binding.organizationId, state.correlationId))
    ) {
      throw aiWorkspaceDisabledError();
    }
  }
}

/**
 * Platform admin v2 (PA-02): the request state's support session. Kept in a map keyed by the
 * request (the request-state shape belongs to the session layer), set by the guard on every
 * tenant-scoped request: the live session when the membership is a support visit, else `null`.
 */
const SUPPORT_SESSIONS = new WeakMap<object, SupportSessionStamp | null>();

/** `state.supportSession` — `undefined` before the guard ran, `null` for an ordinary member. */
export function supportSessionOf(request: object): SupportSessionStamp | null | undefined {
  return SUPPORT_SESSIONS.get(request);
}

function supportSessionFromResolved(resolved: object): SupportSessionStamp | null {
  const raw = (resolved as { supportSession?: unknown }).supportSession;
  if (raw === null || typeof raw !== 'object') return null;
  const candidate = raw as { id?: unknown; adminUserId?: unknown; expiresAt?: unknown };
  if (typeof candidate.id !== 'string' || typeof candidate.adminUserId !== 'string') return null;
  return {
    id: candidate.id,
    adminUserId: candidate.adminUserId,
    ...(candidate.expiresAt instanceof Date || typeof candidate.expiresAt === 'string'
      ? { expiresAt: candidate.expiresAt }
      : {}),
  };
}

/** Recorded on `sessions.revoked_reason` when a company's session lifetime ends a session. */
export const ORG_SESSION_MAX_HOURS_REASON = 'org_session_max_hours';

/** The AI switches the MCP and OAuth modules provide, else a fail-closed set over the database. */
function resolveAiSwitches(moduleRef: ModuleRef, database: TenantDatabase): AiAccessSwitches {
  try {
    return moduleRef.get<AiAccessSwitches>(AI_ACCESS_SWITCHES, { strict: false });
  } catch {
    return createAiAccessSwitches(
      database,
      environmentAiDisabled(process.env['TMANAGE_MCP_DISABLED']),
    );
  }
}

/** The production checks over the database. */
export function createTenantGuardChecks(
  database: TenantDatabase,
  aiSwitches: AiAccessSwitches,
  sessionService: Pick<SessionService, 'revoke'> | undefined,
  policies: PoliciesRepository = new PoliciesRepository(),
  sessionRows: Pick<SessionsRepository, 'findById'> = new SessionsRepository(),
  now: () => number = () => Date.now(),
): TenantGuardChecks {
  return {
    aiSwitches,
    async sessionMaxHours(runner, context) {
      // Wave 10 R5 (F52a). No stored policy means the defaults are in force — the policy screen
      // shows `DEFAULT_POLICY.session_max_hours` (24 h) as "In force now", so that is what is
      // enforced (the owner can raise it to 720). The same rule F52b applies to invitations.
      const row = await policies.find(runner, context);
      return normalizePolicy(row?.policyJson).session_max_hours;
    },
    async sessionOlderThan(sessionId, hours, correlationId) {
      const found = await database.identityRead({ correlationId, tables: ['sessions'] }, (runner) =>
        sessionRows.findById(runner, sessionId),
      );
      if (found === null) return false;
      return now() - found.session.createdAt.getTime() > hours * 3_600_000;
    },
    async endSession(sessionId, correlationId) {
      if (sessionService === undefined) return;
      try {
        await sessionService.revoke({
          sessionId,
          reason: ORG_SESSION_MAX_HOURS_REASON,
          correlationId,
        });
      } catch {
        // The 401 stands whether or not the revocation was written; the next request is refused
        // again by the same check.
      }
    },
  };
}
