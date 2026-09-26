import { Module } from '@nestjs/common';
import type { DynamicModule, Provider } from '@nestjs/common';
import { TENANT_DATABASE } from '../../common/http/tokens.js';
import type { TenantDatabase } from '../../common/database/tenant-context.js';
import { HomeService } from './home.service.js';
import { HomePulseRepository } from './home-pulse.repository.js';
import { HomePulseService } from './home-pulse.service.js';
import { HomePulseController } from './home-pulse.controller.js';

/**
 * The Home Pulse/Focus module's wiring (HOME-01, x143).
 *
 * A separate module from {@link HomeModule} so this slice adds no controller or provider to it: a
 * pure read over existing, indexed tables (`work_items`, `meetings`) plus the Waiting reads it reuses
 * through a stateless {@link HomeService}. It builds its own `HomeService` (stateless over the same
 * tenant database) rather than importing `HomeModule`, so the waiting-gating rule stays single-
 * sourced without constructing a second copy of that module's controller. No new table, no write.
 */
@Module({})
export class HomePulseModule {
  static register(): DynamicModule {
    const service: Provider = {
      provide: HomePulseService,
      inject: [TENANT_DATABASE],
      useFactory: (database: TenantDatabase) =>
        new HomePulseService(database, new HomePulseRepository(), new HomeService(database)),
    };

    return {
      module: HomePulseModule,
      providers: [service],
      exports: [service],
      controllers: [HomePulseController],
    };
  }
}
