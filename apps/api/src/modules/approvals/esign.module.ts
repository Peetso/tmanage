import { Module } from '@nestjs/common';
import type { DynamicModule, Provider } from '@nestjs/common';
import type { Mailer } from '@tmanage/mail';
import type { ObjectStore } from '@tmanage/storage';
import type { TenantDatabase } from '../../common/database/tenant-context.js';
import { MAILER, OBJECT_STORE, TENANT_DATABASE } from '../../common/http/tokens.js';
import { PublicLinkSecrets } from '../public-links/public-link-secrets.js';
import { ESIGN_SERVICE, EsignController, PortalEsignController } from './esign.controller.js';
import { EsignService } from './esign.service.js';
import {
  PortalSignedPdfController,
  SIGNED_PDF_SERVICE,
  SignedPdfController,
} from './record-pdf.controller.js';
import { RecordPdfStore, SignedPdfService } from './record-pdf.service.js';

export interface EsignModuleOptions {
  /** `PUBLIC_LINK_PEPPER` — the e-mail code is an HMAC under the same pepper as 56-07's codes. */
  readonly pepper: string;
  /** The web app's public origin, for the link in the request e-mail (`null`: no link). */
  readonly webPublicUrl: string | null;
}

/** The e-sign service and its signed-PDF service, built together (each needs the other). */
const ESIGN_PAIR = Symbol.for('tmanage.EsignWithSignedPdf');

/** 52-26 wiring — its own module, like `PortalJourneyModule`, so `ApprovalsModule` stays untouched. */
@Module({})
export class EsignModule {
  static register(options: EsignModuleOptions): DynamicModule {
    // 52-26: the signed PDF is produced once a signature commits, and served on download.
    const wired = (database: TenantDatabase, store: ObjectStore, mailer: Mailer | undefined) => {
      let signedPdf: SignedPdfService | null = null;
      const esign = new EsignService({
        database,
        store,
        mailer: mailer ?? null,
        secrets: new PublicLinkSecrets(options.pepper),
        webPublicUrl: options.webPublicUrl,
        onSigned: (context, requestId) =>
          signedPdf === null ? Promise.resolve() : signedPdf.produce(context, requestId),
      });
      signedPdf = new SignedPdfService(esign, new RecordPdfStore(store));
      return { esign, signedPdf };
    };
    const pair: Provider = {
      provide: ESIGN_PAIR,
      inject: [TENANT_DATABASE, OBJECT_STORE, { token: MAILER, optional: true }],
      useFactory: wired,
    };
    const service: Provider = {
      provide: ESIGN_SERVICE,
      inject: [ESIGN_PAIR],
      useFactory: (p: ReturnType<typeof wired>) => p.esign,
    };
    const signedPdfService: Provider = {
      provide: SIGNED_PDF_SERVICE,
      inject: [ESIGN_PAIR],
      useFactory: (p: ReturnType<typeof wired>) => p.signedPdf,
    };
    return {
      module: EsignModule,
      providers: [pair, service, signedPdfService],
      controllers: [
        EsignController,
        PortalEsignController,
        SignedPdfController,
        PortalSignedPdfController,
      ],
    };
  }
}
