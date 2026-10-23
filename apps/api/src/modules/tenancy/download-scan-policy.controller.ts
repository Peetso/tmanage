import { Body, Controller, Get, Inject, Optional, Patch } from '@nestjs/common';
import { authorize } from '@tmanage/domain';
import type { Principal } from '@tmanage/domain';
import { Ctx, CurrentPrincipal, RequireCapability } from '../../common/http/decorators.js';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import { AUDIT_SERVICE, MALWARE_SCANNER, TENANT_DATABASE } from '../../common/http/tokens.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { AuditService } from '../audit/audit.service.js';
import {
  DOWNLOADS_BEFORE_SCAN_KEY,
  readDownloadScanPolicy,
  scannerConfigured,
  storedDownloadsBeforeScan,
  effectiveDownloadsBeforeScan,
} from './download-scan-policy.js';
import type { ScannerPresence } from './download-scan-policy.js';
import { validateValue } from './org-settings.allowlist.js';
import type { DownloadsBeforeScan } from './org-settings.allowlist.js';
import { OrgSettingsRepository } from './org-settings.repository.js';

/**
 * B3 — "Downloads before a virus scan", the company owner's setting.
 *
 * - `GET  …/file-download-policy` (`org.manage`): the stored value, the effective one and whether
 *   a scanner is configured, so the settings screen can explain an `allow_labeled` it cannot change.
 * - `PATCH …/file-download-policy` (`org.manage` and **owner** only): set `allow_labeled` or `block`.
 *   An org_admin or any other role is a 403 with no write. The change and its audit row
 *   (`organization.download_scan_policy_changed`, previous and new value) commit together.
 *
 * The generic `PUT …/settings/:key` refuses this key for everyone (`OWNER_ONLY_SETTING_KEYS`), so
 * this route is the only writer.
 */
export interface DownloadScanPolicyView {
  /** What the owner chose (or the default `allow_labeled`). */
  readonly downloadsBeforeScan: DownloadsBeforeScan;
  /** What downloads obey: `allow_labeled` whenever no scanner is configured. */
  readonly effective: DownloadsBeforeScan;
  readonly scannerConfigured: boolean;
}

interface PatchBody {
  readonly downloadsBeforeScan?: unknown;
}

@Controller('v1/organizations/:orgSlug/file-download-policy')
export class DownloadScanPolicyController {
  constructor(
    @Inject(TENANT_DATABASE) private readonly database: TenantDatabase,
    @Inject(AUDIT_SERVICE) private readonly audit: AuditService,
    @Optional() @Inject(MALWARE_SCANNER) private readonly scanner?: ScannerPresence,
    @Optional()
    @Inject(OrgSettingsRepository)
    private readonly settings: OrgSettingsRepository = new OrgSettingsRepository(),
  ) {}

  @Get()
  @RequireCapability('org.manage')
  async read(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
  ): Promise<DownloadScanPolicyView> {
    requireOrgManage(principal, context);
    const policy = await readDownloadScanPolicy(
      this.database,
      context,
      this.scanner,
      this.settings,
    );
    return {
      downloadsBeforeScan: policy.stored,
      effective: policy.effective,
      scannerConfigured: policy.scannerConfigured,
    };
  }

  @Patch()
  @RequireCapability('org.manage')
  async update(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Body() body: PatchBody,
  ): Promise<DownloadScanPolicyView> {
    const next = await this.database.transaction(context, async (tx) => {
      const org = await this.settings.resolveOrganization(tx, context);
      if (!org) throw new ApiError(404, 'not_found', MESSAGES.notFound);

      requireOrgManage(principal, context);
      if (principal.kind !== 'internal' || principal.role !== 'owner') {
        throw new ApiError(
          403,
          'forbidden',
          'Only the company owner can change this setting.',
          undefined,
          'download_scan_policy.write:not_owner',
        );
      }

      const raw = body?.downloadsBeforeScan;
      const validation =
        typeof raw === 'string' ? validateValue(DOWNLOADS_BEFORE_SCAN_KEY, raw) : undefined;
      if (!validation || !validation.ok) {
        throw new ApiError(400, 'validation_failed', 'The request body is invalid', [
          {
            field: 'downloadsBeforeScan',
            message: validation && !validation.ok ? validation.message : 'A value is required.',
          },
        ]);
      }
      const value = storedDownloadsBeforeScan(validation.value);

      const before = await this.settings.findByKey(tx, context, DOWNLOADS_BEFORE_SCAN_KEY);
      const previous = storedDownloadsBeforeScan(before?.settingValue);
      await this.settings.upsert(tx, context, {
        key: DOWNLOADS_BEFORE_SCAN_KEY,
        value,
        updatedBy: principal.userId,
      });
      await this.audit.record(tx, context, {
        action: 'organization.download_scan_policy_changed',
        objectId: context.organizationId,
        result: 'allowed',
        actorUserId: principal.userId,
        metadata: { previous, value },
      });
      return value;
    });

    const hasScanner = scannerConfigured(this.scanner);
    return {
      downloadsBeforeScan: next,
      effective: effectiveDownloadsBeforeScan(next, hasScanner),
      scannerConfigured: hasScanner,
    };
  }
}

/** The org-wide `org.manage` decision, as `OrgSettingsController` makes it. */
function requireOrgManage(principal: Principal, context: TenantContext): void {
  const verdict = authorize({
    principal,
    capability: 'org.manage',
    resource: {
      organizationId: context.organizationId,
      projectId: null,
      audience: 'internal',
      lifecycle: 'active',
    },
  });
  if (!verdict.allowed) {
    throw new ApiError(
      403,
      'forbidden',
      MESSAGES.forbidden,
      undefined,
      `download_scan_policy:${verdict.code}`,
    );
  }
}
