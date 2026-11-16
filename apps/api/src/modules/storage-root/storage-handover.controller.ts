import { Body, Controller, Get, HttpCode, Inject, Module, Post, Query } from '@nestjs/common';
import type { DynamicModule, Provider } from '@nestjs/common';
import type { Principal } from '@tmanage/domain';
import { Ctx, CurrentPrincipal, RequireCapability } from '../../common/http/decorators.js';
import { AUDIT_SERVICE, TENANT_DATABASE } from '../../common/http/tokens.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { AuditService } from '../audit/audit.service.js';
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
    return {
      module: StorageRootModule,
      providers: [service],
      controllers: [StorageHandoverController],
    };
  }
}
