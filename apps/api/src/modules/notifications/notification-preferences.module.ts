import { Module } from '@nestjs/common';
import type { DynamicModule, Provider } from '@nestjs/common';
import {
  NOTIFICATION_PREFERENCES_REPOSITORY,
  NOTIFICATION_PREFERENCES_SERVICE,
  TENANT_DATABASE,
} from '../../common/http/tokens.js';
import type { TenantDatabase } from '../../common/database/tenant-context.js';
import { NotificationPreferencesController } from './notification-preferences.controller.js';
import { NotificationPreferencesRepository } from './notification-preferences.repository.js';
import { NotificationPreferencesService } from './notification-preferences.service.js';

/**
 * NOTIF-001 preferences wiring.
 *
 * A repository, a service over `TENANT_DATABASE`, and the caller's-own GET/PUT route. Kept in
 * a module of its own rather than folded into `InboxModule`: the inbox reads notification
 * *records* and resolves their objects through the work and requests services; preferences
 * touch neither, so sharing that module would import a dependency graph this route has no use
 * for. Every provider carries an explicit token (ADR-0003).
 */
@Module({})
export class NotificationPreferencesModule {
  static register(): DynamicModule {
    const repository: Provider = {
      provide: NOTIFICATION_PREFERENCES_REPOSITORY,
      useFactory: () => new NotificationPreferencesRepository(),
    };

    const service: Provider = {
      provide: NOTIFICATION_PREFERENCES_SERVICE,
      inject: [TENANT_DATABASE, NOTIFICATION_PREFERENCES_REPOSITORY],
      useFactory: (database: TenantDatabase, preferences: NotificationPreferencesRepository) =>
        new NotificationPreferencesService(database, preferences),
    };

    return {
      module: NotificationPreferencesModule,
      providers: [repository, service],
      exports: [service],
      controllers: [NotificationPreferencesController],
    };
  }
}
