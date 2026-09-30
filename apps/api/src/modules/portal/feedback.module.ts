import { Module } from '@nestjs/common';
import type { DynamicModule, Provider } from '@nestjs/common';
import { TENANT_DATABASE } from '../../common/http/tokens.js';
import type { TenantDatabase } from '../../common/database/tenant-context.js';
import { PortalFeedbackController } from './feedback.controller.js';
import { PortalFeedbackService } from './feedback.service.js';

/**
 * Portal deliverable feedback wiring — x321 (module 13, Client Portal).
 *
 * A module of its own, registered in `app.module.ts` directly rather than folded into
 * `ClientsModule`, so this slice's files stay disjoint from the sibling portal slices that also
 * extend `ClientsModule`. It provides one service over the global `TENANT_DATABASE` (@Global
 * `DatabaseModule`); the service constructs its own stateless repositories.
 */
@Module({})
export class PortalFeedbackModule {
  static register(): DynamicModule {
    const service: Provider = {
      provide: PortalFeedbackService,
      inject: [TENANT_DATABASE],
      useFactory: (database: TenantDatabase) => new PortalFeedbackService(database),
    };

    return {
      module: PortalFeedbackModule,
      providers: [service],
      controllers: [PortalFeedbackController],
    };
  }
}
