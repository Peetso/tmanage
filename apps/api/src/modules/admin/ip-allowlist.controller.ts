import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Module,
  Param,
  Post,
} from '@nestjs/common';
import type { DynamicModule, Provider } from '@nestjs/common';
import type { Principal } from '@tmanage/domain';
import { Ctx, CurrentPrincipal, RequireCapability } from '../../common/http/decorators.js';
import { AUDIT_SERVICE, TENANT_DATABASE } from '../../common/http/tokens.js';
import type { AuditService } from '../audit/audit.service.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import { AdminIpAllowlistService } from './ip-allowlist.service.js';
import type { IpAllowlistEntryView } from './ip-allowlist.service.js';

/**
 * Organization IP allowlist — Administration module 18 (x277). The controller for a security admin's
 * advisory list of allowed IP/CIDR ranges: list them, add one, remove one. Thin over
 * {@link AdminIpAllowlistService}, which owns the authorization, validation and the tenant-scoped data
 * access.
 *
 * Advisory record only — this slice **records** ranges and does not refuse a request by source IP
 * (enforcement is a later slice). Every route is behind `org.security.manage`, the security-admin gate;
 * no capability is invented and `capabilities.ts` is untouched. It is distinct from the
 * security-settings surface (x176), which stores one posture blob per org — this is a separate entry
 * table (`org_ip_allowlist`, 0146).
 */

/**
 * The entries-list read. Not a `…View` and not a named web interface — it is the endpoint's envelope
 * around the one paired projection ({@link IpAllowlistEntryView}), the shape the billing-contacts list
 * read uses inline. The element is what the contracts gate pairs.
 */
export type IpAllowlistList = {
  readonly entries: readonly IpAllowlistEntryView[];
};

/** DI token for the co-located service, so no `tokens.ts` edit is needed for this slice. */
const ADMIN_IP_ALLOWLIST_SERVICE = Symbol.for('tmanage.AdminIpAllowlistService');

@Controller('v1/organizations/:orgSlug/admin/ip-allowlist')
export class AdminIpAllowlistController {
  constructor(
    @Inject(ADMIN_IP_ALLOWLIST_SERVICE) private readonly entries: AdminIpAllowlistService,
  ) {}

  /** List the tenant's allowlist entries. `org.security.manage`. */
  @Get()
  @RequireCapability('org.security.manage')
  async list(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
  ): Promise<IpAllowlistList> {
    const entries = await this.entries.list(context, principal);
    return { entries };
  }

  /** Add an allowlist entry. `org.security.manage`. 201 with the created entry; duplicate → 409. */
  @Post()
  @RequireCapability('org.security.manage')
  @HttpCode(201)
  async add(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Body() body: unknown,
  ): Promise<IpAllowlistEntryView> {
    return this.entries.add(context, principal, body);
  }

  /**
   * Remove an allowlist entry, tenant-scoped. Resolves the entry (404, no write) before authorizing
   * (`org.security.manage`, 403); an absent or cross-tenant id is the same 404. 204 No Content on
   * success — the delete is idempotent at the storage layer.
   */
  @Delete(':entryId')
  @RequireCapability('org.security.manage')
  @HttpCode(204)
  async remove(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('entryId') entryId: string,
  ): Promise<void> {
    await this.entries.remove(context, principal, entryId);
  }
}

/**
 * x277's wiring — a self-contained module registered from `app.module.ts` (the shared append point),
 * so the Administration slices stay file-disjoint. The service is constructed here with the `@Global`
 * `TENANT_DATABASE`; the controller injects it.
 */
@Module({})
export class AdminIpAllowlistModule {
  static register(): DynamicModule {
    const service: Provider = {
      provide: ADMIN_IP_ALLOWLIST_SERVICE,
      inject: [TENANT_DATABASE, { token: AUDIT_SERVICE, optional: true }],
      useFactory: (database: TenantDatabase, audit?: AuditService) =>
        new AdminIpAllowlistService(database, undefined, audit),
    };

    return {
      module: AdminIpAllowlistModule,
      providers: [service],
      controllers: [AdminIpAllowlistController],
    };
  }
}
