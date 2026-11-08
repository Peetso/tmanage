import { Module } from '@nestjs/common';
import type { DynamicModule } from '@nestjs/common';
import { NotificationMatrixController } from './notification-matrix.controller.js';

/**
 * 53-15 notification matrix wiring. Just the controller: it reads the `@Global` `TENANT_DATABASE`
 * and defaults its own repositories (`@Optional`), the shape the per-kind module takes. A module of
 * its own so the slice stays file-disjoint from the per-kind and coarse preference modules.
 */
@Module({})
export class NotificationMatrixModule {
  static register(): DynamicModule {
    return {
      module: NotificationMatrixModule,
      controllers: [NotificationMatrixController],
    };
  }
}
