import { Module } from '@nestjs/common';
import type { DynamicModule, Provider } from '@nestjs/common';
import { TENANT_DATABASE } from '../../common/http/tokens.js';
import type { TenantDatabase } from '../../common/database/tenant-context.js';
import { JourneyStepsController } from './journey-steps.controller.js';
import { JOURNEY_STEPS_SERVICE, JourneyStepsService } from './journey-steps.service.js';
import { PortalJourneyController } from './portal-journey.controller.js';
import { PortalJourneyService } from './portal-journey.service.js';

/** 52-27 wiring — its own module, like `PortalFeedbackModule`, so `ClientsModule` stays untouched. */
@Module({})
export class PortalJourneyModule {
  static register(): DynamicModule {
    const service: Provider = {
      provide: PortalJourneyService,
      inject: [TENANT_DATABASE],
      useFactory: (database: TenantDatabase) => new PortalJourneyService(database),
    };
    const steps: Provider = {
      provide: JOURNEY_STEPS_SERVICE,
      inject: [TENANT_DATABASE],
      useFactory: (database: TenantDatabase) => new JourneyStepsService(database),
    };

    return {
      module: PortalJourneyModule,
      providers: [service, steps],
      controllers: [PortalJourneyController, JourneyStepsController],
    };
  }
}
