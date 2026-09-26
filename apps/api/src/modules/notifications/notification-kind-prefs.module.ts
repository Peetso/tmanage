import { Module } from '@nestjs/common';
import type { DynamicModule } from '@nestjs/common';
import { NotificationKindPrefsController } from './notification-kind-prefs.controller.js';

/**
 * Per-kind notification opt-out wiring (x152).
 *
 * Just the controller: it reads the `@Global` `TENANT_DATABASE` and defaults its own repository
 * (`@Optional`), so there is no provider to register — the same shape the Home pins controller takes.
 * Kept in a module of its own rather than folded into `NotificationPreferencesModule` so it stays
 * file-disjoint from the coarse-preferences slice it sits beside.
 */
@Module({})
export class NotificationKindPrefsModule {
  static register(): DynamicModule {
    return {
      module: NotificationKindPrefsModule,
      controllers: [NotificationKindPrefsController],
    };
  }
}
