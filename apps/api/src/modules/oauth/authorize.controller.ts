import { Controller, Get, Inject, Query, Req, Res, UseGuards } from '@nestjs/common';
import { AiPlatformSwitchGuard } from './ai-access.js';
import { NoTenant, Public } from '../../common/http/decorators.js';
import { requireRequestState } from '../../common/http/request-state.js';
import { ApiError } from '../../common/http/errors.js';
import { OAuthError, type OAuthService } from './oauth.service.js';
import { OAUTH_OPTIONS, OAUTH_SERVICE } from './oauth.tokens.js';
import type { OAuthOptions } from './oauth.module.js';

interface RequestLike {
  readonly headers: Record<string, string | string[] | undefined>;
}

interface ReplyLike {
  status(code: number): ReplyLike;
  header(name: string, value: string): ReplyLike;
  type(contentType: string): ReplyLike;
  send(payload?: unknown): unknown;
}

/**
 * `GET /oauth/authorize` (MCP connector S7).
 *
 * This endpoint validates the request and hands off to the browser consent page (S9). It never
 * mints anything itself — the code is issued only after the signed-in user approves on the consent
 * page, whose POST calls `OAuthService.grantConsent`.
 *
 * Validation order is the security property (threat model B1): the client and the redirect are
 * checked first and, if either is wrong, **no redirect happens** — the browser is shown a plain
 * error rather than bounced to an unverified location (T-OA-04). A missing or non-S256 PKCE
 * challenge is also fatal with no redirect (T-OA-02). Only errors discovered after the redirect is
 * trusted (response_type, resource, scope) are sent back to the client, always carrying `iss`.
 */
// S11: 503 while the platform AI switch is off.
@UseGuards(AiPlatformSwitchGuard)
@Controller('oauth')
export class OAuthAuthorizeController {
  constructor(
    @Inject(OAUTH_SERVICE) private readonly oauth: OAuthService,
    @Inject(OAUTH_OPTIONS) private readonly options: OAuthOptions,
  ) {}

  @Get('authorize')
  @Public()
  @NoTenant()
  async authorize(
    @Req() request: RequestLike,
    @Res() reply: ReplyLike,
    @Query() query: Record<string, unknown>,
  ): Promise<void> {
    const { correlationId } = requireRequestState(request);
    const rawRedirect = typeof query['redirect_uri'] === 'string' ? query['redirect_uri'] : '';
    const state = typeof query['state'] === 'string' ? query['state'] : null;

    let validated;
    try {
      validated = await this.oauth.validateAuthorize(
        {
          responseType: query['response_type'],
          clientId: query['client_id'],
          redirectUri: query['redirect_uri'],
          codeChallenge: query['code_challenge'],
          codeChallengeMethod: query['code_challenge_method'],
          resource: query['resource'],
          scope: query['scope'],
          state: query['state'],
        },
        correlationId,
      );
    } catch (error) {
      if (error instanceof OAuthError && error.redirectable && rawRedirect !== '') {
        // The redirect was validated before this error, so it is safe to use.
        reply
          .status(302)
          .header(
            'location',
            this.oauth.buildRedirect(rawRedirect, {
              error: error.code,
              errorDescription: error.description,
              state,
            }),
          )
          .header('cache-control', 'no-store')
          .send();
        return;
      }
      this.renderError(reply, error);
      return;
    }

    // Validated: carry the exact parameters to the consent page, which will render the decision.
    const consent = new URL(this.options.consentUrl);
    consent.searchParams.set('client_id', validated.clientId);
    consent.searchParams.set('redirect_uri', validated.redirectUri);
    consent.searchParams.set('code_challenge', validated.challenge);
    consent.searchParams.set('code_challenge_method', 'S256');
    consent.searchParams.set('resource', validated.resource);
    consent.searchParams.set('scope', validated.scopes.join(' '));
    if (validated.state !== null) consent.searchParams.set('state', validated.state);
    reply
      .status(302)
      .header('location', consent.toString())
      .header('cache-control', 'no-store')
      .send();
  }

  private renderError(reply: ReplyLike, error: unknown): void {
    // NV07: the client metadata fetch is capped; over the cap nothing was fetched — say so.
    if (error instanceof ApiError && error.status === 429) {
      reply
        .status(429)
        .header('retry-after', '60')
        .header('cache-control', 'no-store')
        .header('x-frame-options', 'DENY')
        .type('text/html; charset=utf-8')
        .send(
          `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Try again soon</title>` +
            `<meta http-equiv="Content-Security-Policy" content="frame-ancestors 'none'"></head>` +
            `<body><h1>Too many requests</h1><p>${escapeHtml(error.message)}</p></body></html>`,
        );
      return;
    }
    const status = error instanceof OAuthError ? error.httpStatus : 400;
    const description =
      error instanceof OAuthError ? error.description : 'The authorization request is invalid.';
    const code = error instanceof OAuthError ? error.code : 'invalid_request';
    // A non-redirectable error is never sent to the client's redirect: a minimal, unframed page.
    reply
      .status(status)
      .header('cache-control', 'no-store')
      .header('x-frame-options', 'DENY')
      .type('text/html; charset=utf-8')
      .send(
        `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Authorization error</title>` +
          `<meta http-equiv="Content-Security-Policy" content="frame-ancestors 'none'"></head>` +
          `<body><h1>Authorization request refused</h1><p>${escapeHtml(description)}</p>` +
          `<p><code>${escapeHtml(code)}</code></p></body></html>`,
      );
  }
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
