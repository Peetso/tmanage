import { Module } from '@nestjs/common';
import type { DynamicModule } from '@nestjs/common';
import { API_CONFIG, TENANT_DATABASE } from '../../common/http/tokens.js';
import type { ApiConfig } from '../../common/http/api-config.js';
import type { TenantDatabase } from '../../common/database/tenant-context.js';
import { tokenVaultFromEnv } from './token-vault.js';
import { ConnectorsController } from './connectors.controller.js';
import { CONNECTORS_SERVICE, ConnectorsService } from './connectors.service.js';

/**
 * 54-01 — the connector framework. Always registered: it needs nothing from the environment
 * beyond the token vault's keyrings (`FIELD_CIPHER_KEYS`, legacy `AUTH_MFA_SEED_KEYS`), and
 * switches no provider on.
 */
@Module({})
export class ConnectorsModule {
  static register(): DynamicModule {
    return {
      module: ConnectorsModule,
      providers: [
        {
          provide: CONNECTORS_SERVICE,
          inject: [TENANT_DATABASE, API_CONFIG],
          useFactory: (database: TenantDatabase, config: ApiConfig) =>
            new ConnectorsService(
              database,
              tokenVaultFromEnv(config.mfaSeedKeys).slot('connector_token'),
            ),
        },
      ],
      exports: [CONNECTORS_SERVICE],
      controllers: [ConnectorsController],
    };
  }
}
