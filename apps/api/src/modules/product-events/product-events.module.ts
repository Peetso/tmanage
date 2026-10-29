import { Module } from '@nestjs/common';
import type { DynamicModule } from '@nestjs/common';
import type { TenantDatabase } from '../../common/database/tenant-context.js';
import { TENANT_DATABASE } from '../../common/http/tokens.js';
import { platformAdminCore } from '../platform-admin/platform-admin-core.module.js';
import { EASE_SCOREBOARD_SERVICE, EaseScoreboardController } from './ease-scoreboard.controller.js';
import { PRODUCT_EVENTS_SERVICE, ProductEventsController } from './product-events.controller.js';
import { ProductEventsRepository } from './product-events.repository.js';
import { ProductEventsService } from './product-events.service.js';

/** The optional server salt for actor hashes; absent → a random per-process salt (safe). */
function actorSalt(): string | undefined {
  return process.env['PRODUCT_EVENTS_ACTOR_SALT'];
}

/**
 * 55-21 ingest wiring — the two tenant routes over the global `TENANT_DATABASE`. Registered by
 * `AppModule` beside the other tenant modules; it resolves no tenant object of its own.
 */
@Module({})
export class ProductEventsModule {
  static register(): DynamicModule {
    return {
      module: ProductEventsModule,
      providers: [
        {
          provide: PRODUCT_EVENTS_SERVICE,
          inject: [TENANT_DATABASE],
          useFactory: (database: TenantDatabase) =>
            new ProductEventsService({
              repository: new ProductEventsRepository(database),
              salt: actorSalt(),
            }),
        },
      ],
      controllers: [ProductEventsController],
    };
  }
}

/**
 * 55-21 Platform admin "Ease scoreboard" wiring — a platform area module (listed in
 * `platform-admin.areas.ts`), importing `platformAdminCore()` for the guard and its lookups.
 */
@Module({})
export class EaseScoreboardModule {
  static register(): DynamicModule {
    return {
      module: EaseScoreboardModule,
      imports: [platformAdminCore()],
      providers: [
        {
          provide: EASE_SCOREBOARD_SERVICE,
          inject: [TENANT_DATABASE],
          useFactory: (database: TenantDatabase) =>
            new ProductEventsService({ repository: new ProductEventsRepository(database) }),
        },
      ],
      controllers: [EaseScoreboardController],
    };
  }
}
