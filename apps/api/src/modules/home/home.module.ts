import { Module } from '@nestjs/common';
import type { DynamicModule, Provider } from '@nestjs/common';
import { HOME_SERVICE, TENANT_DATABASE } from '../../common/http/tokens.js';
import type { TenantDatabase } from '../../common/database/tenant-context.js';
import { MyDayRepository } from './my-day.repository.js';
import { WaitingRepository } from './waiting.repository.js';
import { SavedContextRepository } from './saved-context.repository.js';
import { HomeService } from './home.service.js';
import { HomeController } from './home.controller.js';
import { HomePinsController } from './home-pins.controller.js';
import { RecentItemsController } from './recent-items.controller.js';
import { OnboardingTourController } from './onboarding-tour.controller.js';

/**
 * The Home module's wiring.
 *
 * Mostly a read module over existing, indexed tables: it owns a `MyDayRepository` (HOME-03, over
 * `work_items`), a `WaitingRepository` (HOME-04, over `approvals`/`client_requests`), a
 * `SavedContextRepository` (HOME-05, over the new `saved_context` table plus the referenced tables
 * it resolves against) and a `HomeService`. HOME-05 is the one write path — pin/unpin its own
 * `saved_context` rows — and it needs no audit or outbox: a private per-user pin is not a governed
 * event. It does not import `WorkModule` or `ApprovalsModule` (that would build a second copy of a
 * `.register()` dynamic module, controller and all); it reuses only the work module's stateless
 * `WorkItemView` projection at the type level and reads the other modules' tables directly.
 */
@Module({})
export class HomeModule {
  static register(): DynamicModule {
    const service: Provider = {
      provide: HOME_SERVICE,
      inject: [TENANT_DATABASE],
      useFactory: (database: TenantDatabase) =>
        new HomeService(
          database,
          new MyDayRepository(),
          new WaitingRepository(),
          new SavedContextRepository(),
        ),
    };

    return {
      module: HomeModule,
      providers: [service],
      exports: [service],
      controllers: [
        HomeController,
        HomePinsController,
        RecentItemsController,
        OnboardingTourController,
      ],
    };
  }
}
