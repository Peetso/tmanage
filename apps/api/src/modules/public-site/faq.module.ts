import { Module } from '@nestjs/common';
import type { DynamicModule, Provider } from '@nestjs/common';
import { FaqContentController } from './faq.controller.js';
import { PUBLIC_FAQ_SERVICE, FaqContentService } from './faq.service.js';

/**
 * The public FAQ page's wiring — module 1 (x186).
 *
 * No database, no tenant provider, no mailer: the service depends on nothing and holds
 * deterministic, code-defined copy. It carries an explicit token (ADR-0003) and sits in the
 * public-site module directory alongside the other public slices, each in its own files so they
 * stay file-disjoint. Its position in `app.module.ts` is free.
 */
@Module({})
export class FaqContentModule {
  static register(): DynamicModule {
    const service: Provider = {
      provide: PUBLIC_FAQ_SERVICE,
      useFactory: () => new FaqContentService(),
    };

    return {
      module: FaqContentModule,
      controllers: [FaqContentController],
      providers: [service],
      exports: [service],
    };
  }
}
