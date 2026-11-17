import { Body, Controller, Get, HttpCode, Inject, Module, Post, Query } from '@nestjs/common';
import type { DynamicModule, Provider } from '@nestjs/common';
import type { Principal } from '@tmanage/domain';
import { Ctx, CurrentPrincipal, RequireCapability } from '../../common/http/decorators.js';
import type { ObjectStore } from '@tmanage/storage';
import type { ApiConfig } from '../../common/http/api-config.js';
import {
  API_CONFIG,
  AUDIT_SERVICE,
  OBJECT_STORE,
  TENANT_DATABASE,
} from '../../common/http/tokens.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { AuditService } from '../audit/audit.service.js';
import { providerObjectSources } from '../files/provider-object-sources.js';
import {
  STORAGE_MOVE_JOB,
  StorageMoveJob,
  StorageMovePass,
  storageMoveJobEnabled,
} from './storage-move-job.js';
import { STORAGE_MOVE_SERVICE, StorageMoveController } from './storage-move.controller.js';
import { StorageMoveService } from './storage-move.service.js';
import {
  StorageHandoverService,
  parseProvider,
  type StorageHandoverTargetList,
  type StorageHandoverView,
} from './storage-handover.service.js';

/**
 * 51-17. The company storage hand-over, beside the provider routes:
 *
 * - `GET  …/integrations/storage/handover-targets?provider=` — the admins who could take over.
 * - `POST …/integrations/storage/handover` — `{provider, toUserId}`: name the admin; their own
 *   reconnect from the Storage screen completes it.
 *
 * Both behind `org.security.manage` (Owner, Org Admin); the service authorizes again.
 */

const STORAGE_HANDOVER_SERVICE = Symbol.for('tmanage.StorageHandoverService');

@Controller('v1/organizations/:orgSlug/integrations/storage')
export class StorageHandoverController {
  constructor(
    @Inject(STORAGE_HANDOVER_SERVICE) private readonly handover: StorageHandoverService,
  ) {}

  @Get('handover-targets')
  @RequireCapability('org.security.manage')
  async targets(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Query('provider') provider: unknown,
  ): Promise<StorageHandoverTargetList> {
    return this.handover.targets(context, principal, parseProvider(provider));
  }

  @Post('handover')
  @RequireCapability('org.security.manage')
  @HttpCode(200)
  async request(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Body() body: unknown,
  ): Promise<StorageHandoverView> {
    return this.handover.request(context, principal, body);
  }
}

@Module({})
export class StorageRootModule {
  static register(): DynamicModule {
    const service: Provider = {
      provide: STORAGE_HANDOVER_SERVICE,
      inject: [TENANT_DATABASE, AUDIT_SERVICE],
      useFactory: (database: TenantDatabase, audit: AuditService) =>
        new StorageHandoverService(database, audit),
    };
    // 57-13b. The "Move to Drive" job runs here, in the API, where the vault and the provider
    // transports are; the routes only start it and read it.
    const moveJob: Provider = {
      provide: STORAGE_MOVE_JOB,
      inject: [TENANT_DATABASE, OBJECT_STORE, AUDIT_SERVICE, API_CONFIG],
      useFactory: (
        database: TenantDatabase,
        store: ObjectStore,
        audit: AuditService,
        config: ApiConfig,
      ) =>
        new StorageMoveJob(
          new StorageMovePass(
            database,
            store,
            providerObjectSources(database, audit, config),
            audit,
          ),
          storageMoveJobEnabled(),
        ),
    };
    const moveService: Provider = {
      provide: STORAGE_MOVE_SERVICE,
      inject: [TENANT_DATABASE, AUDIT_SERVICE, STORAGE_MOVE_JOB],
      useFactory: (database: TenantDatabase, audit: AuditService, job: StorageMoveJob) =>
        new StorageMoveService(database, audit, job),
    };
    return {
      module: StorageRootModule,
      providers: [service, moveJob, moveService],
      controllers: [StorageHandoverController, StorageMoveController],
    };
  }
}
