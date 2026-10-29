import { Module } from '@nestjs/common';
import type { DynamicModule } from '@nestjs/common';
import { platformAdminCore } from './platform-admin-core.module.js';
import { PLATFORM_AREA_MODULES } from './platform-admin.areas.js';
import { PlatformAdminController } from './platform-admin.controller.js';

/**
 * Platform admin (`/v1/platform/*`). Registered by `AppModule` when `PLATFORM_ADMIN_EMAILS`
 * names somebody (the routes otherwise do not exist and answer the router's ordinary 404); the
 * guard also answers 404 while both the server list and the team table are empty, so a
 * mis-wired registration still fails closed.
 *
 * This module holds `me` and `step-up`; the core (`platform-admin-core.module.ts`) holds the
 * shared providers; every other route lives in its area module (`platform-admin.areas.ts`).
 */
@Module({})
export class PlatformAdminModule {
  static register(): DynamicModule {
    return {
      module: PlatformAdminModule,
      imports: [platformAdminCore(), ...PLATFORM_AREA_MODULES],
      controllers: [PlatformAdminController],
    };
  }
}
