import { randomUUID } from 'node:crypto';
import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Optional,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import {
  AI_ACCESS_SWITCHES,
  AiPlatformSwitchGuard,
  aiWorkspaceDisabledError,
} from './ai-access.js';
import type { AiAccessSwitches } from './ai-access.js';
import type { TenantContext } from '../../common/database/tenant-context.js';
import { Ctx, CurrentSession, NoTenant, RequireCapability } from '../../common/http/decorators.js';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import { requireRequestState } from '../../common/http/request-state.js';
import type { AuthenticatedSession } from '../identity/session.service.js';
import {
  type ConsentTickets,
  describeClient,
  PLATFORM_CONSENT_CHECK,
  platformAiScopeMinutes,
  platformWindowEnd,
  resolveGrantedScopes,
  type ConsentClientView,
  type PlatformConsentCheck,
} from './consent.js';
import { SCOPE_PLATFORM } from './scopes.js';
import {
  parseWorksAs,
  WORKS_AS_PORT,
  type ConsentWorksAsView,
  type WorksAsPort,
} from './works-as.js';
import { OAuthError, type OAuthService, type ValidatedAuthorize } from './oauth.service.js';
import { OAUTH_SERVICE } from './oauth.tokens.js';

/** Injection token for the in-memory consent-ticket signer (one per process). */
export const CONSENT_TICKETS = Symbol.for('tmanage.OAuthConsentTickets');

interface RequestLike {
  readonly headers: Record<string, string | string[] | undefined>;
  /** The client address (Fastify's `request.ip`), charged against the CIMD per-source budget. */
  readonly ip?: string;
}

interface ReplyLike {
  header(name: string, value: string): ReplyLike;
}

/** The authorize parameters the consent page carries, from its URL, on every call. */
interface ConsentParams {
  readonly client_id?: unknown;
  readonly redirect_uri?: unknown;
  readonly code_challenge?: unknown;
  readonly code_challenge_method?: unknown;
  readonly resource?: unknown;
  readonly scope?: unknown;
  readonly state?: unknown;
}

interface DecisionBody extends ConsentParams {
  readonly ticket?: unknown;
  readonly scopes?: unknown;
  /** 60-07 "works as": absent / `"me"` = the person, otherwise an AI employee's id. */
  readonly worksAs?: unknown;
}

export interface ConsentView {
  readonly client: ConsentClientView;
  /**
   * What the client asked for, in display order. The page pre-ticks these. Never
   * `tmanage:platform` (ADR-0015 F11: off by default, the person ticks it).
   */
  readonly requestedScopes: readonly string[];
  /**
   * F11: whether the page shows the platform switch (`offered`: a platform admin) and whether it
   * can be ticked now (`ready`: two-step on and a fresh step-up in this session).
   */
  readonly platform: { readonly offered: boolean; readonly ready: boolean };
  /** Bound to this session and these parameters; the decision must send it back. */
  readonly ticket: string;
}

/**
 * The consent page's API (MCP connector S9; threat model B2).
 *
 * `/oauth/authorize` validates a request and hands the browser to `/connect/authorize`; that page
 * calls these routes with the signed-in person's cookie session:
 *
 * - `GET /v1/oauth/consent` re-validates the parameters (nothing the URL says is trusted) and
 *   returns what the page shows plus a consent ticket bound to this session.
 * - `POST /v1/organizations/:orgSlug/oauth/consent` approves. The org is in the path so the
 *   ordinary guard chain proves the membership and builds the tenant context the grant is bound
 *   to; CSRF is enforced by the global guard. Answers JSON `{ redirectUrl }` rather than a 302:
 *   the page navigates with `location.assign`, which `form-action 'self'` cannot block (B2
 *   gotcha in the architecture).
 * - `POST /v1/oauth/consent/deny` sends the client `error=access_denied`.
 *
 * - 60-07 `GET /v1/organizations/:orgSlug/oauth/consent/works-as` lists the AI employees the
 *   person may connect the app as (S5, "This agent works as"); the approve body's `worksAs` names
 *   the choice, which the AI-employee module re-checks inside the grant's transaction.
 *
 * All of them refuse anything but a cookie session: a personal access token or an AI grant must
 * never approve an OAuth client (B3, "cannot create OAuth clients or change its own grant").
 */
// S11: 503 while the platform AI switch is off.
@UseGuards(AiPlatformSwitchGuard)
@Controller()
export class OAuthConsentController {
  constructor(
    @Inject(OAUTH_SERVICE) private readonly oauth: OAuthService,
    @Inject(CONSENT_TICKETS) private readonly tickets: ConsentTickets,
    @Inject(AI_ACCESS_SWITCHES) private readonly aiAccess: AiAccessSwitches,
    /** ADR-0015 F11. Absent (unit tests): the platform scope is never offered or granted. */
    @Optional()
    @Inject(PLATFORM_CONSENT_CHECK)
    private readonly platformCheck?: PlatformConsentCheck,
    /** 60-07. Absent (unit tests, or a server without the AI-employee module): "Me" only. */
    @Optional()
    @Inject(WORKS_AS_PORT)
    private readonly worksAs?: WorksAsPort,
  ) {}

  private async platformStanding(session: AuthenticatedSession, correlationId: string) {
    if (this.platformCheck === undefined) {
      return { offered: false, ready: false, stepUpExpiresAt: null };
    }
    return this.platformCheck.standing(session.userId, session.sessionId, correlationId);
  }

  @Get('v1/oauth/consent')
  @NoTenant()
  async view(
    @CurrentSession() session: AuthenticatedSession,
    @Query() query: ConsentParams,
    @Req() request: RequestLike,
    @Res({ passthrough: true }) reply: ReplyLike,
  ): Promise<ConsentView> {
    const state = this.requireCookie(request);
    noStore(reply);
    const validated = await this.validate(query, state.correlationId, request.ip);
    const platform = await this.platformStanding(session, state.correlationId);
    return {
      client: describeClient({ ...validated, name: validated.clientName }),
      requestedScopes: validated.scopes.filter((scope) => scope !== SCOPE_PLATFORM),
      platform: { offered: platform.offered, ready: platform.ready },
      ticket: this.tickets.mint(bindingOf(session, validated)),
    };
  }

  /** 60-07 (S5): the AI employees this person may connect the app as, in this workspace. */
  @Get('v1/organizations/:orgSlug/oauth/consent/works-as')
  @RequireCapability('work.read')
  async worksAsOptions(
    @Ctx() context: TenantContext,
    @Req() request: RequestLike,
    @Res({ passthrough: true }) reply: ReplyLike,
  ): Promise<ConsentWorksAsView> {
    this.requireCookie(request);
    noStore(reply);
    if (this.worksAs === undefined) return { aiEmployees: [] };
    return this.worksAs.options(context);
  }

  @Post('v1/organizations/:orgSlug/oauth/consent')
  @RequireCapability('work.read')
  @HttpCode(200)
  async approve(
    @Ctx() context: TenantContext,
    @CurrentSession() session: AuthenticatedSession,
    @Body() body: DecisionBody,
    @Req() request: RequestLike,
    @Res({ passthrough: true }) reply: ReplyLike,
  ): Promise<{ readonly redirectUrl: string }> {
    const state = this.requireCookie(request);
    noStore(reply);
    const validated = await this.validate(body ?? {}, state.correlationId, request.ip);
    if (!this.tickets.verify(body?.ticket, bindingOf(session, validated))) {
      throw new ApiError(403, 'forbidden', MESSAGES.forbidden, undefined, 'consent_ticket_invalid');
    }
    // S11: no new connection while the workspace owner has AI apps turned off.
    if (!(await this.aiAccess.organizationOn(context.organizationId, state.correlationId))) {
      throw aiWorkspaceDisabledError();
    }
    const choice = parseWorksAs(body?.worksAs);
    if (!choice.ok) {
      throw new ApiError(400, 'validation_failed', 'The connection request is not valid', [
        { field: 'worksAs', message: 'must be "me" or an AI employee id' },
      ]);
    }
    if (choice.aiEmployeeId !== null) {
      // 60-07: the grant works as an AI employee — `tmanage:agent` only, whatever the page sent
      // as scopes; every rule is re-checked by the binder inside the grant's transaction.
      if (this.worksAs === undefined) {
        throw new ApiError(404, 'not_found', MESSAGES.notFound, undefined, 'ai_employee:not_found');
      }
      const { redirectUrl } = await this.oauth.grantConsent(
        context,
        {
          clientPk: validated.clientPk,
          membershipId: context.membershipId,
          userId: context.userId,
          redirectUri: validated.redirectUri,
          challenge: validated.challenge,
          resource: validated.resource,
          scopes: [],
          state: validated.state,
          sessionId: session.sessionId,
          worksAs: this.worksAs.binder(choice.aiEmployeeId),
        },
        { grantId: randomUUID() },
      );
      return { redirectUrl };
    }
    const role = state.membership?.role ?? '';
    // ADR-0015 F11: `tmanage:platform` only for a platform admin with two-step on and a step-up
    // in this session minutes old; decided here, on the server, at the moment of consent.
    const wantsPlatform = Array.isArray(body?.scopes) && body.scopes.includes(SCOPE_PLATFORM);
    const platform = wantsPlatform
      ? await this.platformStanding(session, state.correlationId)
      : { offered: false, ready: false, stepUpExpiresAt: null };
    const granted = resolveGrantedScopes(body?.scopes, role, platform.ready);
    if (!granted.ok) {
      throw new ApiError(
        403,
        'forbidden',
        MESSAGES.forbidden,
        undefined,
        wantsPlatform && !platform.ready ? 'consent_platform_refused' : 'consent_billing_role',
      );
    }
    const platformBinding = granted.scopes.includes(SCOPE_PLATFORM)
      ? {
          stepUpSessionId: session.sessionId,
          until: platformWindowEnd(
            new Date(),
            platformAiScopeMinutes(process.env),
            platform.stepUpExpiresAt,
          ),
        }
      : undefined;
    const { redirectUrl } = await this.oauth.grantConsent(
      context,
      {
        clientPk: validated.clientPk,
        membershipId: context.membershipId,
        userId: context.userId,
        redirectUri: validated.redirectUri,
        challenge: validated.challenge,
        resource: validated.resource,
        scopes: granted.scopes,
        state: validated.state,
        // N04: re-checked after the grant commits; a session ended meanwhile revokes it (401).
        sessionId: session.sessionId,
        ...(platformBinding !== undefined ? { platform: platformBinding } : {}),
      },
      { grantId: randomUUID() },
    );
    return { redirectUrl };
  }

  @Post('v1/oauth/consent/deny')
  @NoTenant()
  @HttpCode(200)
  async deny(
    @Body() body: ConsentParams,
    @Req() request: RequestLike,
    @Res({ passthrough: true }) reply: ReplyLike,
  ): Promise<{ readonly redirectUrl: string }> {
    const state = this.requireCookie(request);
    noStore(reply);
    const validated = await this.validate(body ?? {}, state.correlationId, request.ip);
    return {
      redirectUrl: this.oauth.buildRedirect(validated.redirectUri, {
        error: 'access_denied',
        errorDescription: 'The user declined the connection.',
        state: validated.state,
      }),
    };
  }

  private requireCookie(request: RequestLike) {
    const state = requireRequestState(request);
    if (state.authScheme !== 'cookie') {
      throw new ApiError(403, 'forbidden', MESSAGES.forbidden, undefined, 'consent_needs_session');
    }
    return state;
  }

  private async validate(
    params: ConsentParams,
    correlationId: string,
    requester: string | undefined,
  ): Promise<ValidatedAuthorize> {
    try {
      return await this.oauth.validateAuthorize(
        {
          responseType: 'code',
          clientId: params.client_id,
          redirectUri: params.redirect_uri,
          codeChallenge: params.code_challenge,
          codeChallengeMethod: params.code_challenge_method,
          resource: params.resource,
          scope: params.scope,
          state: params.state,
        },
        correlationId,
        requester ?? null,
      );
    } catch (error) {
      if (error instanceof OAuthError) {
        throw new ApiError(400, 'validation_failed', 'The connection request is not valid', [
          { field: 'request', message: error.code },
        ]);
      }
      if (error instanceof Error && error.name === 'InvalidScopeError') {
        throw new ApiError(400, 'validation_failed', 'The connection request is not valid', [
          { field: 'scope', message: 'invalid_scope' },
        ]);
      }
      throw error;
    }
  }
}

function bindingOf(session: AuthenticatedSession, validated: ValidatedAuthorize) {
  return {
    sessionId: session.sessionId,
    userId: session.userId,
    clientId: validated.clientId,
    redirectUri: validated.redirectUri,
    challenge: validated.challenge,
    resource: validated.resource,
    state: validated.state,
  };
}

function noStore(reply: ReplyLike): void {
  reply.header('cache-control', 'no-store');
}
