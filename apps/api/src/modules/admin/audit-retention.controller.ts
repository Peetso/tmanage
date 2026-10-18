import { Body, Controller, Get, Inject, Module, Optional, Put } from '@nestjs/common';
import type { DynamicModule } from '@nestjs/common';
import type { Principal } from '@tmanage/domain';
import { Ctx, CurrentPrincipal, RequireCapability } from '../../common/http/decorators.js';
import { TENANT_DATABASE } from '../../common/http/tokens.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import { AuditRetentionService } from './audit-retention.service.js';
import type { AuditRetentionView } from './audit-retention.service.js';

/**
 * Audit-log retention policy (Administration module 18, x279) — the read + update surface the audit
 * named absent (Admin: an org keeps its audit trail forever, with no way to set or preview a retention
 * window). Two routes behind `org.manage`:
 *
 * - `GET  …/admin/audit-retention` — the stored policy plus a read-only purge preview: how many
 *   `audit_events` fall outside the window (0 when no window is set).
 * - `PUT  …/admin/audit-retention` `{ retentionDays }` — set the window (1..3650 days), upserting the
 *   one-per-organization policy and returning the fresh view.
 *
 * ## Preview only — no destructive purge in this slice
 *
 * The route stores a window and previews the count; it never writes to `audit_events`. The append-only
 * table keeps its INSERT-only grant, and the purge is a later, separately-credentialed procedure — the
 * screen says "purge runs later" in as many words, and this controller has no route that could remove a
 * row.
 *
 * ## Two guards, and the order that matters
 *
 * `@RequireCapability('org.manage')` is the coarse gate `CapabilityGuard` reads: a caller whose role
 * does not hold `org.manage` is refused 403 before any handler runs. The service *also* runs the real
 * `authorize` for the same capability — the org-wide, tenant-checked decision — so the safety is a rule
 * the controller test proves directly. The write path resolves the organization tenant-scoped **before**
 * it authorizes or writes (the Known trap): a context whose organization does not exist in this tenant
 * is a 404 with no write, and an out-of-range `retentionDays` is a 400 with no upsert.
 */
@Controller('v1/organizations/:orgSlug/admin/audit-retention')
export class AuditRetentionController {
  constructor(
    @Inject(TENANT_DATABASE) private readonly database: TenantDatabase,
    @Optional()
    @Inject(AuditRetentionService)
    private readonly service: AuditRetentionService = new AuditRetentionService(),
  ) {}

  /** Read the organization's retention policy and the purge preview (200). Read-only. */
  @Get()
  @RequireCapability('org.manage')
  async read(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
  ): Promise<AuditRetentionView> {
    return this.database.read(context, (runner) => this.service.get(runner, context, principal));
  }

  /**
   * Set the organization's retention window (200 — the stored policy plus the fresh preview). The body
   * is validated to shape and range first (400 — zero, negative, fractional, or over 3650 days, no
   * upsert), then the whole decision — organization resolve (404, the Known trap), the caller's
   * `org.manage` (403), and the upsert — runs inside one tenant-scoped transaction.
   */
  @Put()
  @RequireCapability('org.manage')
  async set(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Body() body: unknown,
  ): Promise<AuditRetentionView> {
    const input = this.service.parse(body);
    return this.database.transaction(context, (tx) =>
      this.service.set(tx, context, principal, input),
    );
  }
}

/**
 * x279's wiring — a self-contained module registered from `app.module.ts` (the shared append point), so
 * the Administration slices stay file-disjoint. The service is stateless (a validate step, the real
 * authorize, a tenant-scoped upsert and read), constructed here; the controller injects it and the
 * `@Global` `TENANT_DATABASE`.
 */
@Module({})
export class AdminAuditRetentionModule {
  static register(): DynamicModule {
    return {
      module: AdminAuditRetentionModule,
      providers: [
        { provide: AuditRetentionService, useFactory: () => new AuditRetentionService() },
      ],
      controllers: [AuditRetentionController],
    };
  }
}
