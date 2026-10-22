import { Body, Controller, Inject, Post, Req, Res, UseGuards } from '@nestjs/common';
import { AiPlatformSwitchGuard } from './ai-access.js';
import { NoTenant, Public } from '../../common/http/decorators.js';
import { requireRequestState } from '../../common/http/request-state.js';
import { OAuthError, type OAuthService, type TokenResponse } from './oauth.service.js';
import { OAUTH_SERVICE } from './oauth.tokens.js';

interface RequestLike {
  readonly headers: Record<string, string | string[] | undefined>;
}

interface ReplyLike {
  status(code: number): ReplyLike;
  header(name: string, value: string): ReplyLike;
  send(payload: unknown): unknown;
}

/**
 * `POST /oauth/token` (MCP connector S7) — the one endpoint that mints tokens.
 *
 * Form-urlencoded (RFC 6749 §4.1.3). Two grant types: `authorization_code` exchanges a code for a
 * token pair (PKCE verified, code spent single-use); `refresh_token` rotates (reuse detection
 * revokes the family). Every response carries `Cache-Control: no-store` (RFC 6749 §5.1), and a
 * failure is the RFC error shape `{error, error_description}`, never TManage's own error body.
 * Public and no-tenant: the client proves itself with the code/verifier, not a session.
 */
// S11: 503 while the platform AI switch is off.
@UseGuards(AiPlatformSwitchGuard)
@Controller('oauth')
export class OAuthTokenController {
  constructor(@Inject(OAUTH_SERVICE) private readonly oauth: OAuthService) {}

  @Post('token')
  @Public()
  @NoTenant()
  async token(
    @Req() request: RequestLike,
    @Res() reply: ReplyLike,
    @Body() body: Record<string, unknown>,
  ): Promise<void> {
    const { correlationId } = requireRequestState(request);
    const grantType = typeof body?.['grant_type'] === 'string' ? body['grant_type'] : '';
    try {
      let result: TokenResponse;
      if (grantType === 'authorization_code') {
        result = await this.oauth.exchangeCode(
          {
            code: body['code'],
            codeVerifier: body['code_verifier'],
            redirectUri: body['redirect_uri'],
            clientId: body['client_id'],
            resource: body['resource'],
          },
          correlationId,
        );
      } else if (grantType === 'refresh_token') {
        result = await this.oauth.refresh(
          {
            refreshToken: body['refresh_token'],
            resource: body['resource'],
            clientId: body['client_id'],
          },
          correlationId,
        );
      } else {
        throw new OAuthError(
          'unsupported_grant_type',
          'grant_type must be authorization_code or refresh_token.',
          false,
        );
      }
      reply
        .status(200)
        .header('cache-control', 'no-store')
        .header('pragma', 'no-cache')
        .send(result);
    } catch (error) {
      if (error instanceof OAuthError) {
        reply
          .status(error.httpStatus)
          .header('cache-control', 'no-store')
          .header('pragma', 'no-cache')
          .send({ error: error.code, error_description: error.description });
        return;
      }
      throw error;
    }
  }
}
