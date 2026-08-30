import { Module } from '@nestjs/common';
import type { DynamicModule } from '@nestjs/common';
import { RealtimeController } from './realtime.controller.js';

/** RT-001's API wiring: one controller, no providers — the mint has no state of its own. */
@Module({})
export class RealtimeModule {
  static register(): DynamicModule {
    return {
      module: RealtimeModule,
      controllers: [RealtimeController],
    };
  }
}
