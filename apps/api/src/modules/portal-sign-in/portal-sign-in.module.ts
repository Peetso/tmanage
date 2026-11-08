import { Module } from '@nestjs/common';
import type { DynamicModule, Provider } from '@nestjs/common';
import type { Mailer } from '@tmanage/mail';
import type { ApiConfig } from '../../common/http/api-config.js';
import type { TenantDatabase } from '../../common/database/tenant-context.js';
import { API_CONFIG, MAILER, TENANT_DATABASE } from '../../common/http/tokens.js';
import { SessionService } from '../identity/session.service.js';
import { PublicLinkSecrets } from '../public-links/public-link-secrets.js';
import {
  PORTAL_SIGN_IN_SERVICE,
  PORTAL_SIGN_IN_SESSIONS,
  PortalSignInController,
} from './portal-sign-in.controller.js';
import { PortalSignInRepository } from './portal-sign-in.repository.js';
import { PortalSignInService } from './portal-sign-in.service.js';

export interface PortalSignInModuleOptions {
  /** `PUBLIC_LINK_PEPPER` — the same pepper `PublicLinksModule` hashes magic links with. */
  readonly pepper: string;
}

/** 55-14 wiring: the client portal's e-mail-link sign-in under `/v1/public/portal-sign-in`. */
@Module({})
export class PortalSignInModule {
  static register(options: PortalSignInModuleOptions): DynamicModule {
    const service: Provider = {
      provide: PORTAL_SIGN_IN_SERVICE,
      inject: [TENANT_DATABASE, API_CONFIG, { token: MAILER, optional: true }],
      useFactory: (database: TenantDatabase, config: ApiConfig, mailer?: Mailer | null) => {
        const secrets = new PublicLinkSecrets(options.pepper);
        return new PortalSignInService({
          store: new PortalSignInRepository(database, secrets),
          secrets,
          mailer: mailer ?? null,
          webOrigin: config.webPublicUrl ?? '',
        });
      },
    };
    const sessions: Provider = {
      provide: PORTAL_SIGN_IN_SESSIONS,
      inject: [TENANT_DATABASE, API_CONFIG],
      useFactory: (database: TenantDatabase, config: ApiConfig) =>
        new SessionService(database, config),
    };
    return {
      module: PortalSignInModule,
      providers: [service, sessions],
      controllers: [PortalSignInController],
    };
  }
}
