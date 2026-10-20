import { Body, Controller, HttpCode, Inject, Post, Req } from '@nestjs/common';
import { NoTenant, Public } from '../../common/http/decorators.js';
import { requireRequestState } from '../../common/http/request-state.js';
import { OAUTH_SERVICE } from './oauth.tokens.js';
import type { OAuthService } from './oauth.service.js';

interface RequestLike {
  readonly headers: Record<string, string | string[] | undefined>;
}

/**
 * `POST /oauth/revoke` (RFC 7009, MCP connector S7). Form-urlencoded `{ token }`. Revokes the
 * whole token family the presented token belongs to — an access token or a refresh token.
 * Per RFC 7009 §2.2 an unknown or malformed token is still a 200, so revocation never reveals
 * whether a token existed. Public and no-tenant.
 */
@Controller('oauth')
export class OAuthRevokeController {
  constructor(@Inject(OAUTH_SERVICE) private readonly oauth: OAuthService) {}

  @Post('revoke')
  @Public()
  @NoTenant()
  @HttpCode(200)
  async revoke(
    @Req() request: RequestLike,
    @Body() body: Record<string, unknown>,
  ): Promise<{ readonly status: 'ok' }> {
    const { correlationId } = requireRequestState(request);
    await this.oauth.revoke(body?.['token'], correlationId);
    return { status: 'ok' };
  }
}
