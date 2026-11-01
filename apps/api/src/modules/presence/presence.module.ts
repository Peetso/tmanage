import { Module } from '@nestjs/common';
import type { DynamicModule, Provider } from '@nestjs/common';
import { TENANT_DATABASE } from '../../common/http/tokens.js';
import type { TenantDatabase } from '../../common/database/tenant-context.js';
import { PRESENCE_SERVICE, PresenceController } from './presence.controller.js';
import { PresenceRepository } from './presence.repository.js';
import { PresenceService } from './presence.service.js';

/** R7 presence wiring (F4): heartbeat + read over the global tenant database. */
@Module({})
export class PresenceModule {
  static register(): DynamicModule {
    const service: Provider = {
      provide: PRESENCE_SERVICE,
      inject: [TENANT_DATABASE],
      useFactory: (database: TenantDatabase) =>
        new PresenceService(database, new PresenceRepository()),
    };
    return { module: PresenceModule, providers: [service], controllers: [PresenceController] };
  }
}
