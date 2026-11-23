import { Controller, Get, Inject } from '@nestjs/common';
import { NoTenant, Public } from '../../common/http/decorators.js';
import { CONSENT_SCOPES } from './scopes.js';
import { OAUTH_SERVICE } from './oauth.tokens.js';
import type { OAuthService } from './oauth.service.js';

/**
 * OAuth discovery metadata (MCP connector S7).
 *
 *  - Protected-resource metadata (RFC 9728) at `/.well-known/oauth-protected-resource/mcp` and the
 *    bare `/.well-known/oauth-protected-resource`: names the canonical `resource` and the one
 *    authorization server. A client reaches these after the `/mcp` 401 points at them.
 *  - Authorization-server metadata (RFC 8414) at `/.well-known/oauth-authorization-server`:
 *    advertises S256-only PKCE, public clients (`none`), CIMD support, and the `iss` parameter.
 *
 * All three are `@Public()` and `@NoTenant()`: discovery happens before any sign-in or tenant.
 */
@Controller('.well-known')
export class OAuthMetadataController {
  constructor(@Inject(OAUTH_SERVICE) private readonly oauth: OAuthService) {}

  @Get('oauth-protected-resource/mcp')
  @Public()
  @NoTenant()
  protectedResourceForMcp(): Record<string, unknown> {
    return this.protectedResource();
  }

  @Get('oauth-protected-resource')
  @Public()
  @NoTenant()
  protectedResource(): Record<string, unknown> {
    return {
      resource: this.oauth.resourceUri,
      authorization_servers: [this.oauth.issuerUrl],
      scopes_supported: CONSENT_SCOPES,
      bearer_methods_supported: ['header'],
    };
  }

  @Get('oauth-authorization-server')
  @Public()
  @NoTenant()
  authorizationServer(): Record<string, unknown> {
    const issuer = this.oauth.issuerUrl;
    return {
      issuer,
      authorization_endpoint: `${issuer}/oauth/authorize`,
      token_endpoint: `${issuer}/oauth/token`,
      registration_endpoint: `${issuer}/oauth/register`,
      revocation_endpoint: `${issuer}/oauth/revoke`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
      client_id_metadata_document_supported: true,
      authorization_response_iss_parameter_supported: true,
      scopes_supported: CONSENT_SCOPES,
    };
  }
}
