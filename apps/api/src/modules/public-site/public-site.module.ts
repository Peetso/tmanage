import { Module } from '@nestjs/common';
import type { DynamicModule, Provider } from '@nestjs/common';
import { PublicContentController } from './public-content.controller.js';
import { PUBLIC_CONTENT_SERVICE, PublicContentService } from './public-content.service.js';

/**
 * Public & trust site (module 1) wiring.
 *
 * A single service holding the marketing copy and the one `@Public()` read that serves it. The
 * module depends on nothing — no database, no mailer, no tenant context — so its position in
 * `app.module.ts` is free; it is registered beside the other feature modules for discoverability
 * rather than for any ordering constraint. The service carries an explicit token (ADR-0003).
 */
@Module({})
export class PublicSiteModule {
  static register(): DynamicModule {
    const service: Provider = {
      provide: PUBLIC_CONTENT_SERVICE,
      useFactory: () => new PublicContentService(),
    };

    return {
      module: PublicSiteModule,
      providers: [service],
      exports: [service],
      controllers: [PublicContentController],
    };
  }
}
