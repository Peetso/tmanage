import { Controller, Get, Inject } from '@nestjs/common';
import type { Principal } from '@tmanage/domain';
import { Ctx, CurrentPrincipal, RequireCapability } from '../../common/http/decorators.js';
import type { TenantContext } from '../../common/database/tenant-context.js';
import { AUDIT_INTEGRITY_SERVICE } from './audit-integrity.service.js';
import type {
  AuditExportManifest,
  AuditIntegrityReport,
  AuditIntegrityService,
} from './audit-integrity.service.js';
import type { AuditCatalogEntry } from './audit-catalog.js';

/**
 * 56-11 — the audit chain's internal routes. Tenant-scoped like every org controller: the
 * {@link TenantContext} comes from the guard, nothing reads an organization id from the request.
 * `@RequireCapability` refuses first; the service checks again (and adds the org-wide-scope rule
 * for `integrity`). All three are reads: nothing here writes, so no route needs an audit action.
 *
 * - `GET …/admin/audit/integrity` (`audit.read`) — verify the chain; first bad row id only.
 * - `GET …/admin/audit/catalog` (`audit.read`) — every audit action with EN/AR descriptions.
 * - `GET …/admin/audit/export.sig` (`audit.export`) — the signed chain head for an export.
 */
@Controller('v1/organizations/:orgSlug/admin/audit')
export class AuditIntegrityController {
  constructor(@Inject(AUDIT_INTEGRITY_SERVICE) private readonly integrity: AuditIntegrityService) {}

  @Get('integrity')
  @RequireCapability('audit.read')
  async verify(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
  ): Promise<AuditIntegrityReport> {
    return this.integrity.verify(context, principal);
  }

  @Get('catalog')
  @RequireCapability('audit.read')
  catalog(@CurrentPrincipal() principal: Principal): {
    readonly actions: readonly AuditCatalogEntry[];
  } {
    return { actions: this.integrity.catalog(principal) };
  }

  @Get('export.sig')
  @RequireCapability('audit.export')
  async exportSignature(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
  ): Promise<AuditExportManifest> {
    return this.integrity.exportManifest(context, principal);
  }
}
