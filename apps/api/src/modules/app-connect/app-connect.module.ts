import { Module } from '@nestjs/common';
import type { DynamicModule, Provider } from '@nestjs/common';
import { API_CONFIG, AUDIT_SERVICE, TENANT_DATABASE } from '../../common/http/tokens.js';
import type { ApiConfig } from '../../common/http/api-config.js';
import type { TenantDatabase } from '../../common/database/tenant-context.js';
import { createSeedCipher } from '../identity/seed-cipher.js';
import { ConnectorsRepository } from '../connectors/connectors.repository.js';
import type { AuditService } from '../audit/audit.service.js';
import {
  APP_CONNECT_HTTP_OPTIONS,
  AppConnectCallbackController,
  AppConnectController,
  type AppConnectHttpOptions,
} from './app-connect.controller.js';
import { APP_CONNECT_SERVICE, AppConnectService } from './app-connect.service.js';
import { createGitHubClient, gitHubOAuthConfigFrom } from './github.oauth.js';

/**
 * FIX5 — one-click Connect for GitHub. Always registered: without its env vars the card says
 * "Not set up yet" and Connect answers 409 `not_configured`. Slack and Microsoft Teams were
 * removed on 2026-11-10 (no routes; stored rows are left alone).
 */
@Module({})
export class AppConnectModule {
  static register(): DynamicModule {
    const service: Provider = {
      provide: APP_CONNECT_SERVICE,
      inject: [TENANT_DATABASE, API_CONFIG, AUDIT_SERVICE],
      useFactory: (database: TenantDatabase, config: ApiConfig, audit: AuditService) =>
        new AppConnectService({
          database,
          cipher: createSeedCipher(config.mfaSeedKeys),
          vault: new ConnectorsRepository(),
          audit,
          config: { github: gitHubOAuthConfigFrom(process.env) },
          apiPublicUrl: config.apiPublicUrl ?? config.webPublicUrl ?? '',
          github: createGitHubClient(),
          log: (message) => console.warn(message),
        }),
    };
    const httpOptions: Provider = {
      provide: APP_CONNECT_HTTP_OPTIONS,
      inject: [API_CONFIG],
      useFactory: (config: ApiConfig): AppConnectHttpOptions => ({
        sessionSecret: config.sessionSecret,
        secureCookies: config.secureCookies,
        webPublicUrl: config.webPublicUrl ?? '',
      }),
    };
    return {
      module: AppConnectModule,
      providers: [service, httpOptions],
      exports: [APP_CONNECT_SERVICE],
      controllers: [AppConnectController, AppConnectCallbackController],
    };
  }
}
