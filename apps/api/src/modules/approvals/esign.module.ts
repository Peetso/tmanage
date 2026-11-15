import { Module } from '@nestjs/common';
import type { DynamicModule, Provider } from '@nestjs/common';
import type { Mailer } from '@tmanage/mail';
import type { ObjectStore } from '@tmanage/storage';
import type { TenantDatabase } from '../../common/database/tenant-context.js';
import { MAILER, OBJECT_STORE, TENANT_DATABASE } from '../../common/http/tokens.js';
import { PublicLinkSecrets } from '../public-links/public-link-secrets.js';
import { ESIGN_SERVICE, EsignController, PortalEsignController } from './esign.controller.js';
import { EsignService } from './esign.service.js';

export interface EsignModuleOptions {
  /** `PUBLIC_LINK_PEPPER` — the e-mail code is an HMAC under the same pepper as 56-07's codes. */
  readonly pepper: string;
  /** The web app's public origin, for the link in the request e-mail (`null`: no link). */
  readonly webPublicUrl: string | null;
}

/** 52-26 wiring — its own module, like `PortalJourneyModule`, so `ApprovalsModule` stays untouched. */
@Module({})
export class EsignModule {
  static register(options: EsignModuleOptions): DynamicModule {
    const service: Provider = {
      provide: ESIGN_SERVICE,
      inject: [TENANT_DATABASE, OBJECT_STORE, { token: MAILER, optional: true }],
      useFactory: (database: TenantDatabase, store: ObjectStore, mailer: Mailer | undefined) =>
        new EsignService({
          database,
          store,
          mailer: mailer ?? null,
          secrets: new PublicLinkSecrets(options.pepper),
          webPublicUrl: options.webPublicUrl,
        }),
    };
    return {
      module: EsignModule,
      providers: [service],
      controllers: [EsignController, PortalEsignController],
    };
  }
}
