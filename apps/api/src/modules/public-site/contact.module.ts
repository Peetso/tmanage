import { Module } from '@nestjs/common';
import type { DynamicModule, Provider } from '@nestjs/common';
import { MARKETING_LEADS_REPOSITORY, TENANT_DATABASE } from '../../common/http/tokens.js';
import type { TenantDatabase } from '../../common/database/tenant-context.js';
import { ContactController } from './contact.controller.js';
import { MarketingLeadsRepository } from './contact.repository.js';

/**
 * x161. The public site's contact / lead intake wiring.
 *
 * A module of its own — one distinct file — rather than a shared `public-site.module.ts`, so this
 * slice stays file-disjoint from the sibling public-site slices (home, pricing, trust, status,
 * changelog): each registers here in `app.module.ts` rather than all editing one module file. The
 * repository writes on the identity (no-tenant) path, so it depends on `TENANT_DATABASE` and
 * nothing else; every provider carries an explicit token (ADR-0003).
 */
@Module({})
export class ContactModule {
  static register(): DynamicModule {
    const repository: Provider = {
      provide: MARKETING_LEADS_REPOSITORY,
      inject: [TENANT_DATABASE],
      useFactory: (database: TenantDatabase) => new MarketingLeadsRepository(database),
    };

    return {
      module: ContactModule,
      providers: [repository],
      controllers: [ContactController],
    };
  }
}
