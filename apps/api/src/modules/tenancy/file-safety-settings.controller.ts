import { Body, Controller, Get, Inject, Optional, Put } from '@nestjs/common';
import { authorize } from '@tmanage/domain';
import type { Principal } from '@tmanage/domain';
import { Ctx, CurrentPrincipal, RequireCapability } from '../../common/http/decorators.js';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import { AUDIT_SERVICE, MALWARE_SCANNER, TENANT_DATABASE } from '../../common/http/tokens.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { AuditService } from '../audit/audit.service.js';
import { SubscriptionRepository } from '../billing/subscription.repository.js';
import { FILE_TYPE_PRESETS, isFileTypePreset, presetsToCsv } from '../files/file-safety.js';
import type { FileTypePreset } from '../files/file-safety.js';
import type { ScannerPresence } from './download-scan-policy.js';
import { FILE_SAFETY_PRESETS_KEY, readFileSafetySettingsWith } from './file-safety-settings.js';
import type { FileSafetySettings } from './file-safety-settings.js';
import { OrgSettingsRepository } from './org-settings.repository.js';

/**
 * 56-06 (R19-e) — Security → File safety, the backend.
 *
 * - `GET …/security/file-safety`: the enabled type presets, the plan's per-file cap (read-only),
 *   whether clients download only scanned-clean files, and whether a scanner is present.
 * - `PUT …/security/file-safety` `{presets}`: set the enabled presets. The change and its audit row
 *   (`org.file_safety_changed`, before/after) commit together. FIX6: `requireScanForClients` is
 *   read-only here; the owner sets it as "Files clients can receive"
 *   (`PATCH …/client-file-policy`), the one writer of that key.
 *
 * Capability: `org.security.manage` on both (exists; no capabilities.ts edit). Under `security/`
 * rather than `settings/` on purpose: the generic `PUT …/settings/:key` would capture
 * `settings/file-safety` as a key. Both keys are refused by that generic route
 * (`OWNER_ONLY_SETTING_KEYS`), so this route is the only writer. The GET is a registry `read` op
 * (`org.settings.file_safety.get`); the PUT is withheld (`never.ts`, `org_security_manage`).
 */
export interface FileSafetySettingsView {
  readonly presets: readonly FileTypePreset[];
  readonly availablePresets: readonly FileTypePreset[];
  readonly maxFileBytes: number;
  readonly requireScanForClients: boolean;
  readonly scannerPresent: boolean;
}

interface PutBody {
  readonly presets?: unknown;
}

export function toFileSafetyView(settings: FileSafetySettings): FileSafetySettingsView {
  return {
    presets: settings.presets,
    availablePresets: FILE_TYPE_PRESETS,
    maxFileBytes: settings.maxFileBytes,
    requireScanForClients: settings.requireScanForClients,
    scannerPresent: settings.scannerPresent,
  };
}

@Controller('v1/organizations/:orgSlug/security/file-safety')
export class FileSafetySettingsController {
  constructor(
    @Inject(TENANT_DATABASE) private readonly database: TenantDatabase,
    @Inject(AUDIT_SERVICE) private readonly audit: AuditService,
    @Optional() @Inject(MALWARE_SCANNER) private readonly scanner?: ScannerPresence,
    @Optional()
    @Inject(OrgSettingsRepository)
    private readonly settings: OrgSettingsRepository = new OrgSettingsRepository(),
    @Optional()
    @Inject(SubscriptionRepository)
    private readonly subscriptions: SubscriptionRepository = new SubscriptionRepository(),
  ) {}

  @Get()
  @RequireCapability('org.security.manage')
  async read(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
  ): Promise<FileSafetySettingsView> {
    requireSecurityManage(principal, context);
    const current = await this.database.read(context, (runner) =>
      readFileSafetySettingsWith(runner, context, this.scanner, this.settings, this.subscriptions),
    );
    return toFileSafetyView(current);
  }

  @Put()
  @RequireCapability('org.security.manage')
  async update(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Body() body: PutBody,
  ): Promise<FileSafetySettingsView> {
    const input = parseBody(body);
    const after = await this.database.transaction(context, async (tx) => {
      const org = await this.settings.resolveOrganization(tx, context);
      if (!org) throw new ApiError(404, 'not_found', MESSAGES.notFound);
      requireSecurityManage(principal, context);

      const before = await readFileSafetySettingsWith(
        tx,
        context,
        this.scanner,
        this.settings,
        this.subscriptions,
      );
      await this.settings.upsert(tx, context, {
        key: FILE_SAFETY_PRESETS_KEY,
        value: presetsToCsv(input.presets),
        updatedBy: principal.userId,
      });
      const next = await readFileSafetySettingsWith(
        tx,
        context,
        this.scanner,
        this.settings,
        this.subscriptions,
      );
      await this.audit.record(tx, context, {
        action: 'org.file_safety_changed',
        objectId: context.organizationId,
        result: 'allowed',
        actorUserId: principal.userId,
        metadata: {
          presets_before: [...before.presets],
          presets_after: [...next.presets],
        },
      });
      return next;
    });
    return toFileSafetyView(after);
  }
}

/** Validate the PUT body: presets, a non-empty list of known names. */
export function parseBody(body: PutBody | undefined): {
  readonly presets: readonly FileTypePreset[];
} {
  const raw = body?.presets;
  if (
    raw === undefined ||
    !Array.isArray(raw) ||
    raw.length === 0 ||
    !raw.every((name) => typeof name === 'string' && isFileTypePreset(name))
  ) {
    throw new ApiError(400, 'validation_failed', 'The request body is invalid', [
      { field: 'presets', message: 'Choose at least one of the offered file types.' },
    ]);
  }
  return { presets: FILE_TYPE_PRESETS.filter((preset) => (raw as string[]).includes(preset)) };
}

/** The real org-wide `org.security.manage` decision; a denial is a 403. */
function requireSecurityManage(principal: Principal, context: TenantContext): void {
  const verdict = authorize({
    principal,
    capability: 'org.security.manage',
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
      `file_safety_settings:${verdict.code}`,
    );
  }
}
