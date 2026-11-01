import { Module } from '@nestjs/common';
import type { DynamicModule, Provider } from '@nestjs/common';
import { PublicContentController } from './public-content.controller.js';
import { LegalController } from './legal.controller.js';
import { PUBLIC_CONTENT_SERVICE, PublicContentService } from './public-content.service.js';
import { PlanCatalogController, PLAN_CATALOG_SERVICE } from './plan-catalog.controller.js';
import { PlanCatalogService } from './plan-catalog.service.js';
import { PUBLIC_SITE_STATUS_REPOSITORY } from '../../common/http/tokens.js';
import { StatusRepository } from './status.repository.js';
import { PublicSiteStatusController } from './status.controller.js';
import { PUBLIC_STATUS_LINK, PublicStatusSummaryController } from './status-summary.controller.js';
import { LocaleHintController } from './locale-hint.controller.js';
import { GeoModule } from '../identity/geo/geo.module.js';

/**
 * Public & trust site (module 1) wiring.
 *
 * The marketing home, pricing, and legal (terms/privacy, x188) reads hold deterministic,
 * code-defined copy (no database, no tenant, no capability); the legal route shares the
 * `PublicContentService` this module already provides. The status read (x159) is the one that
 * touches the global database — the
 * GLOBAL `incidents` table (0060) — through a stateless repository, still `@Public()` and tenant-less.
 * Every service and the repository carry explicit tokens (ADR-0003); the module's position in
 * `app.module.ts` is free.
 */
@Module({})
export class PublicSiteModule {
  /** `statusPageUrl` (51-12): the operator's external status page, `STATUS_PAGE_URL`; optional. */
  static register(options: { readonly statusPageUrl?: string | null } = {}): DynamicModule {
    const service: Provider = {
      provide: PUBLIC_CONTENT_SERVICE,
      useFactory: () => new PublicContentService(),
    };

    const planCatalog: Provider = {
      provide: PLAN_CATALOG_SERVICE,
      useFactory: () => new PlanCatalogService(),
    };

    const repository: Provider = {
      provide: PUBLIC_SITE_STATUS_REPOSITORY,
      useFactory: () => new StatusRepository(),
    };

    const statusLink: Provider = {
      provide: PUBLIC_STATUS_LINK,
      useValue: options.statusPageUrl ?? null,
    };

    return {
      module: PublicSiteModule,
      // R12: `GET /v1/public/locale-hint` reads the GeoIP provider.
      imports: [GeoModule],
      providers: [service, planCatalog, repository, statusLink],
      exports: [service],
      controllers: [
        PublicContentController,
        LegalController,
        PlanCatalogController,
        PublicSiteStatusController,
        PublicStatusSummaryController,
        LocaleHintController,
      ],
    };
  }
}
