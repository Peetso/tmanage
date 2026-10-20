import { Module } from '@nestjs/common';
import type { DynamicModule, Provider } from '@nestjs/common';
import { API_CONFIG, TENANT_DATABASE } from '../../common/http/tokens.js';
import type { ApiConfig } from '../../common/http/api-config.js';
import type { TenantDatabase } from '../../common/database/tenant-context.js';
import { OAuthAuthorizeController } from './authorize.controller.js';
import { OAuthMetadataController } from './metadata.controller.js';
import { OAuthRevokeController } from './revoke.controller.js';
import { OAuthTokenController } from './token.controller.js';
import { OAuthFormBodyParser } from './form-body.parser.js';
import { OAuthService } from './oauth.service.js';
import { OauthTokensRepository } from './oauth-tokens.repository.js';
import { OAUTH_OPTIONS, OAUTH_SERVICE } from './oauth.tokens.js';

/** Runtime options the controllers read (the consent page the authorize endpoint hands off to). */
export interface OAuthOptions {
  /** The browser consent page (S9) the authorize endpoint redirects a validated request to. */
  readonly consentUrl: string;
}

/** The API's public origin, or a safe local default when `API_PUBLIC_URL` is not configured. */
function issuerOrigin(config: ApiConfig): string {
  const source = config.apiPublicUrl ?? config.webPublicUrl;
  if (source === undefined || source === '') return 'http://localhost';
  try {
    return new URL(source).origin;
  } catch {
    return 'http://localhost';
  }
}

/**
 * The OAuth 2.1 authorization server (MCP connector S7). Mounts discovery metadata, the authorize,
 * token and revoke endpoints, and registers the form-urlencoded body parser the token/revoke
 * endpoints need. The DCR/CIMD registration endpoint and the consent page are later slices (S8,
 * S9); this slice owns the protocol core and its tables.
 */
@Module({})
export class OAuthModule {
  static register(): DynamicModule {
    const options: Provider = {
      provide: OAUTH_OPTIONS,
      inject: [API_CONFIG],
      useFactory: (config: ApiConfig): OAuthOptions => {
        const webOrigin = config.webPublicUrl ?? issuerOrigin(config);
        return { consentUrl: `${webOrigin.replace(/\/$/, '')}/connect/authorize` };
      },
    };
    const service: Provider = {
      provide: OAUTH_SERVICE,
      inject: [TENANT_DATABASE, API_CONFIG],
      useFactory: (database: TenantDatabase, config: ApiConfig): OAuthService => {
        const issuer = issuerOrigin(config);
        return new OAuthService({
          database,
          repository: new OauthTokensRepository(),
          issuer,
          canonicalResource: `${issuer}/mcp`,
        });
      },
    };
    return {
      module: OAuthModule,
      providers: [options, service, OAuthFormBodyParser],
      controllers: [
        OAuthMetadataController,
        OAuthAuthorizeController,
        OAuthTokenController,
        OAuthRevokeController,
      ],
    };
  }
}
