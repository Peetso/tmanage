import { Module } from '@nestjs/common';
import type { DynamicModule, Provider } from '@nestjs/common';
import { CAPACITY_HEATMAP_SERVICE, TENANT_DATABASE } from '../../common/http/tokens.js';
import type { TenantDatabase } from '../../common/database/tenant-context.js';
import { CapacityHeatmapRepository } from './capacity-heatmap.repository.js';
import { CapacityHeatmapService } from './capacity-heatmap.service.js';
import { CapacityHeatmapController } from './capacity-heatmap.controller.js';

/**
 * Team capacity heatmap (module 14, x193) wiring.
 *
 * One stateless read service under its token, built over the tenant database and the heatmap read
 * repository. No write path and no new table: it reads `person_capacity` (x170) and
 * `person_allocations` (x171) tenant-scoped and folds them into the grid.
 */
@Module({})
export class CapacityHeatmapModule {
  static register(): DynamicModule {
    const service: Provider = {
      provide: CAPACITY_HEATMAP_SERVICE,
      inject: [TENANT_DATABASE],
      useFactory: (database: TenantDatabase) =>
        new CapacityHeatmapService(database, new CapacityHeatmapRepository()),
    };

    return {
      module: CapacityHeatmapModule,
      providers: [service],
      controllers: [CapacityHeatmapController],
    };
  }
}
