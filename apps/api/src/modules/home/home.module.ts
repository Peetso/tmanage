import { Module } from '@nestjs/common';
import type { DynamicModule, Provider } from '@nestjs/common';
import { HOME_SERVICE, TENANT_DATABASE } from '../../common/http/tokens.js';
import type { TenantDatabase } from '../../common/database/tenant-context.js';
import { MyDayRepository } from './my-day.repository.js';
import { HomeService } from './home.service.js';
import { HomeController } from './home.controller.js';

/**
 * HOME-03's wiring.
 *
 * A read-only module over an existing, indexed table: it owns a `MyDayRepository` and a
 * `HomeService` and nothing else — no audit, no outbox, no writes. It does not import
 * `WorkModule` (that would build a second copy of a `.register()` dynamic module, controller and
 * all); it reuses only the work module's stateless `WorkItemView` projection at the type level.
 */
@Module({})
export class HomeModule {
  static register(): DynamicModule {
    const service: Provider = {
      provide: HOME_SERVICE,
      inject: [TENANT_DATABASE],
      useFactory: (database: TenantDatabase) => new HomeService(database, new MyDayRepository()),
    };

    return {
      module: HomeModule,
      providers: [service],
      exports: [service],
      controllers: [HomeController],
    };
  }
}
