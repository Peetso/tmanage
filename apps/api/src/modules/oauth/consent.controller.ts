import { randomUUID } from 'node:crypto';
import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
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
  resolveGrantedScopes,
  type ConsentClientView,
} from './consent.js';
import { OAuthError, type OAuthService, type ValidatedAuthorize } from './oauth.service.js';
import { OAUTH_SERVICE } from './oauth.tokens.js';

/** Injection token for the in-memory consent-ticket signer (one per process). */
export const CONSENT_TICKETS = Symbol.for('tmanage.OAuthConsentTickets');

interface RequestLike {
  readonly headers: Record<string, string | string[] | undefined>;
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
}

export interface ConsentView {
  readonly client: ConsentClientView;
  /** What the client asked for, in display order. The page pre-ticks these. */
  readonly requestedScopes: readonly string[];
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
 * All three refuse anything but a cookie session: a personal access token or an AI grant must
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
  ) {}

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
    const validated = await this.validate(query, state.correlationId);
    return {
      client: describeClient({ ...validated, name: validated.clientName }),
      requestedScopes: validated.scopes,
      ticket: this.tickets.mint(bindingOf(session, validated)),
    };
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
    const validated = await this.validate(body ?? {}, state.correlationId);
    if (!this.tickets.verify(body?.ticket, bindingOf(session, validated))) {
      throw new ApiError(403, 'forbidden', MESSAGES.forbidden, undefined, 'consent_ticket_invalid');
    }
    // S11: no new connection while the workspace owner has AI apps turned off.
    if (!(await this.aiAccess.organizationOn(context.organizationId, state.correlationId))) {
      throw aiWorkspaceDisabledError();
    }
    const role = state.membership?.role ?? '';
    const granted = resolveGrantedScopes(body?.scopes, role);
    if (!granted.ok) {
      throw new ApiError(403, 'forbidden', MESSAGES.forbidden, undefined, 'consent_billing_role');
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
        scopes: granted.scopes,
        state: validated.state,
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
    const validated = await this.validate(body ?? {}, state.correlationId);
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
