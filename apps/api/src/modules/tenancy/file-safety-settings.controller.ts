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
import {
  FILE_SAFETY_PRESETS_KEY,
  REQUIRE_SCAN_FOR_CLIENTS_KEY,
  readFileSafetySettingsWith,
} from './file-safety-settings.js';
import type { FileSafetySettings } from './file-safety-settings.js';
import { OrgSettingsRepository } from './org-settings.repository.js';

/**
 * 56-06 (R19-e) — Security → File safety, the backend.
 *
 * - `GET …/security/file-safety`: the enabled type presets, the plan's per-file cap (read-only),
 *   whether clients download only scanned-clean files, and whether a scanner is present.
 * - `PUT …/security/file-safety` `{presets?, requireScanForClients?}`: set either or both. Turning
 *   `requireScanForClients` on with no scanner configured is a `409 scanner_missing` with no write
 *   — the rule would make every client file unreachable. The change and its audit row
 *   (`org.file_safety_changed`, before/after) commit together.
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
  readonly requireScanForClients?: unknown;
}

export function toFileSafetyView(settings: FileSafetySettings): FileSafetySettingsView {
  return {
    presets: settings.presets,
    availablePresets: FILE_TYPE_PRESETS,
    maxFileBytes: settings.maxFileBytes,
    // What the owner chose; the screen explains it does nothing until a scanner is present.
    requireScanForClients: settings.requireScanForClientsStored && settings.scannerPresent,
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
      if (input.requireScanForClients === true && !before.scannerPresent) {
        throw new ApiError(
          409,
          'scanner_missing',
          'Clients can only be held to scanned files once a virus scanner is set up.',
          [{ field: 'requireScanForClients', message: 'scanner_missing' }],
          'scanner_missing',
        );
      }
      if (input.presets !== undefined) {
        await this.settings.upsert(tx, context, {
          key: FILE_SAFETY_PRESETS_KEY,
          value: presetsToCsv(input.presets),
          updatedBy: principal.userId,
        });
      }
      if (input.requireScanForClients !== undefined) {
        await this.settings.upsert(tx, context, {
          key: REQUIRE_SCAN_FOR_CLIENTS_KEY,
          value: String(input.requireScanForClients),
          updatedBy: principal.userId,
        });
      }
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
          require_scan_before: before.requireScanForClientsStored,
          require_scan_after: next.requireScanForClientsStored,
        },
      });
      return next;
    });
    return toFileSafetyView(after);
  }
}

/** Validate the PUT body: at least one field; presets a non-empty list of known names. */
export function parseBody(body: PutBody | undefined): {
  readonly presets?: readonly FileTypePreset[];
  readonly requireScanForClients?: boolean;
} {
  const details: { field: string; message: string }[] = [];
  let presets: FileTypePreset[] | undefined;
  let requireScanForClients: boolean | undefined;
  if (body?.presets !== undefined) {
    const raw = body.presets;
    if (
      !Array.isArray(raw) ||
      raw.length === 0 ||
      !raw.every((name) => typeof name === 'string' && isFileTypePreset(name))
    ) {
      details.push({ field: 'presets', message: 'Choose at least one of the offered file types.' });
    } else {
      presets = FILE_TYPE_PRESETS.filter((preset) => (raw as string[]).includes(preset));
    }
  }
  if (body?.requireScanForClients !== undefined) {
    if (typeof body.requireScanForClients !== 'boolean') {
      details.push({ field: 'requireScanForClients', message: 'Enter true or false.' });
    } else {
      requireScanForClients = body.requireScanForClients;
    }
  }
  if (details.length === 0 && presets === undefined && requireScanForClients === undefined) {
    details.push({ field: 'presets', message: 'Nothing to change.' });
  }
  if (details.length > 0) {
    throw new ApiError(400, 'validation_failed', 'The request body is invalid', details);
  }
  return {
    ...(presets !== undefined ? { presets } : {}),
    ...(requireScanForClients !== undefined ? { requireScanForClients } : {}),
  };
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
