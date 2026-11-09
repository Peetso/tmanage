import { Module } from '@nestjs/common';
import type { DynamicModule, Provider } from '@nestjs/common';
import { API_CONFIG, TENANT_DATABASE } from '../../common/http/tokens.js';
import type { ApiConfig } from '../../common/http/api-config.js';
import type { TenantDatabase } from '../../common/database/tenant-context.js';
import { createSeedCipher } from '../identity/seed-cipher.js';
import { ConnectorsRepository } from '../connectors/connectors.repository.js';
import { ChannelLinksRepository } from '../automations/channel-links.repository.js';
import { ChannelLinksService } from '../automations/channel-links.service.js';
import {
  APP_CONNECT_HTTP_OPTIONS,
  AppConnectCallbackController,
  AppConnectController,
  type AppConnectHttpOptions,
} from './app-connect.controller.js';
import { APP_CONNECT_SERVICE, AppConnectService } from './app-connect.service.js';
import { createGitHubClient, gitHubOAuthConfigFrom } from './github.oauth.js';
import { createSlackClient, slackOAuthConfigFrom } from './slack.oauth.js';
import { createTeamsClient, teamsOAuthConfigFrom } from './teams.oauth.js';

/**
 * FIX5 — one-click Connect for GitHub, Slack and Microsoft Teams. Always registered: without a
 * provider's env vars its card says "Not set up yet" and Connect answers 409 `not_configured`.
 */
@Module({})
export class AppConnectModule {
  static register(): DynamicModule {
    const service: Provider = {
      provide: APP_CONNECT_SERVICE,
      inject: [TENANT_DATABASE, API_CONFIG],
      useFactory: (database: TenantDatabase, config: ApiConfig) =>
        new AppConnectService({
          database,
          cipher: createSeedCipher(config.mfaSeedKeys),
          vault: new ConnectorsRepository(),
          channels: new ChannelLinksService(database, new ChannelLinksRepository()),
          config: {
            github: gitHubOAuthConfigFrom(process.env),
            slack: slackOAuthConfigFrom(process.env),
            teams: teamsOAuthConfigFrom(process.env),
          },
          apiPublicUrl: config.apiPublicUrl ?? config.webPublicUrl ?? '',
          github: createGitHubClient(),
          slack: createSlackClient(),
          teams: createTeamsClient(),
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
