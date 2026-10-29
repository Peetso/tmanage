import { Module } from '@nestjs/common';
import type { DynamicModule } from '@nestjs/common';
import { TrustContentController } from './trust-content.controller.js';
import { TrustContentService } from './trust-content.service.js';
import { DataLocationService } from './data-location.service.js';

/**
 * The public trust page's wiring — module 1 (x158).
 *
 * No database, no tenant provider, no injection token: the service depends on nothing and is
 * resolved by class. It sits in the public-site module directory alongside the other public
 * slices, each in its own files so they stay file-disjoint.
 */
@Module({})
export class TrustContentModule {
  static register(): DynamicModule {
    return {
      module: TrustContentModule,
      controllers: [TrustContentController],
      providers: [TrustContentService, DataLocationService],
      exports: [TrustContentService],
    };
  }
}
