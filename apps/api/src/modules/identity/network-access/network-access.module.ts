import { Module } from '@nestjs/common';
import type { DynamicModule } from '@nestjs/common';
import { API_CONFIG, TENANT_DATABASE } from '../../../common/http/tokens.js';
import type { ApiConfig } from '../../../common/http/api-config.js';
import type { TenantDatabase } from '../../../common/database/tenant-context.js';
import { DatabaseAuthenticationEventRecorder } from '../../../common/http/authentication-event-recorder.js';
import { CredentialsRepository } from '../credentials.repository.js';
import { createSeedCipher } from '../seed-cipher.js';
import { GeoModule, IP_INTELLIGENCE } from '../geo/geo.module.js';
import { platformAdminCore } from '../../platform-admin/platform-admin-core.module.js';
import type { IpIntelligenceService } from '../geo/ip-intelligence.service.js';
import { PlatformNetworkAccessController } from './network-access.controller.js';
import { NetworkAccessRepository } from './network-access.repository.js';
import {
  NETWORK_ACCESS_SERVICE,
  NetworkAccessService,
  envAllowlist,
} from './network-access.service.js';

/**
 * SEC-ALERTS item 7. The door's service and the platform routes. Registered by `AppModule`, which
 * also registers `NetworkAccessGuard` as a global guard right after the durable throttle (a flood
 * of refused requests is throttled before it costs a lookup and a log row).
 */
@Module({})
export class NetworkAccessModule {
  static register(): DynamicModule {
    return {
      module: NetworkAccessModule,
      // Global (SEC-TRACKER): the attack tracker in the platform area reads a source's standing
      // (blocked, allowlisted, on a list) through this module's published service (AR-5), and a
      // second `register()` there would mount the controller twice.
      global: true,
      // The platform routes sit behind PlatformAdminGuard, whose lookup, allowlist and audit
      // providers live in the shared platform-admin core (one module object for every area).
      imports: [GeoModule, platformAdminCore()],
      controllers: [PlatformNetworkAccessController],
      providers: [
        {
          provide: NETWORK_ACCESS_SERVICE,
          inject: [TENANT_DATABASE, API_CONFIG, IP_INTELLIGENCE],
          useFactory: (database: TenantDatabase, config: ApiConfig, ip: IpIntelligenceService) =>
            new NetworkAccessService(
              new NetworkAccessRepository(database),
              ip,
              // The guard recorder the identity module binds, built the same way (a refusal is a
              // guard row of `authentication_events`, written off the request path).
              new DatabaseAuthenticationEventRecorder(
                database,
                new CredentialsRepository(createSeedCipher(config.mfaSeedKeys)),
              ),
              envAllowlist(config.geoip?.networkAccessAllowlist),
            ),
        },
      ],
      exports: [NETWORK_ACCESS_SERVICE],
    };
  }
}
