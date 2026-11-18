import { Module } from '@nestjs/common';
import type { DynamicModule } from '@nestjs/common';
import { platformAdminCore } from '../platform-admin/platform-admin-core.module.js';
import { PricingSurveyController } from './pricing-survey.controller.js';
import { PlatformPricingSurveyController } from './pricing-survey-platform.controller.js';

/**
 * 57-17 WTP — the willingness-to-pay card's tenant routes. Its own module so it adds nothing to
 * home; the controller builds its repository itself.
 */
@Module({})
export class PricingSurveyModule {
  static register(): DynamicModule {
    return { module: PricingSurveyModule, controllers: [PricingSurveyController] };
  }
}

/**
 * 57-17 WTP — the Platform admin answers list, a platform area module (listed in
 * `platform-admin.areas.ts`), importing `platformAdminCore()` for the guard and its lookups.
 */
@Module({})
export class PlatformPricingSurveyModule {
  static register(): DynamicModule {
    return {
      module: PlatformPricingSurveyModule,
      imports: [platformAdminCore()],
      controllers: [PlatformPricingSurveyController],
    };
  }
}
