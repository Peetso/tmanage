import { Body, Controller, Get, Inject, Optional, Patch } from '@nestjs/common';
import { authorize } from '@tmanage/domain';
import type { Principal } from '@tmanage/domain';
import { Ctx, CurrentPrincipal, RequireCapability } from '../../common/http/decorators.js';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import { AUDIT_SERVICE, MALWARE_SCANNER, TENANT_DATABASE } from '../../common/http/tokens.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { AuditService } from '../audit/audit.service.js';
import {
  REQUIRE_SCAN_FOR_CLIENTS_KEY,
  clientFilesPolicyOn,
  isClientFilesPolicy,
  readClientFilesPolicy,
  storedClientFilesPolicy,
} from './client-file-policy.js';
import type { ClientFilesPolicy } from './client-file-policy.js';
import { scannerConfigured } from './download-scan-policy.js';
import type { ScannerPresence } from './download-scan-policy.js';
import { OrgSettingsRepository } from './org-settings.repository.js';

/**
 * FIX6 item 1 — "Files clients can receive", the company owner's setting, in the pattern of
 * "Downloads before a virus scan" (`download-scan-policy.controller.ts`).
 *
 * - `GET  …/client-file-policy` (`org.manage`): the policy, whether a scanner is configured, and
 *   whether files can be shared with clients at all (`virus_scanned` with no scanner: none can).
 * - `PATCH …/client-file-policy` (`org.manage` and **owner** only): `checked` or `virus_scanned`.
 *   Any other role is a 403 with no write. The change and its audit row
 *   (`organization.client_file_policy_changed`, previous and new value) commit together.
 *
 * This route is the only writer of the key: the generic `PUT …/settings/:key` refuses it
 * (`OWNER_ONLY_SETTING_KEYS`) and `…/security/file-safety` only reads it.
 */
export interface ClientFilePolicyView {
  readonly clientFiles: ClientFilesPolicy;
  readonly scannerConfigured: boolean;
  /** `false` when only virus-scanned files may go and no scanner is set up: nothing can be sent. */
  readonly sharingPossible: boolean;
}

interface PatchBody {
  readonly clientFiles?: unknown;
}

function viewOf(policy: ClientFilesPolicy, hasScanner: boolean): ClientFilePolicyView {
  return {
    clientFiles: policy,
    scannerConfigured: hasScanner,
    sharingPossible: policy === 'checked' || hasScanner,
  };
}

@Controller('v1/organizations/:orgSlug/client-file-policy')
export class ClientFilePolicyController {
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
  ): Promise<ClientFilePolicyView> {
    requireOrgManage(principal, context);
    const policy = await readClientFilesPolicy(this.database, context, this.scanner, this.settings);
    return viewOf(policy, scannerConfigured(this.scanner));
  }

  @Patch()
  @RequireCapability('org.manage')
  async update(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Body() body: PatchBody,
  ): Promise<ClientFilePolicyView> {
    const hasScanner = scannerConfigured(this.scanner);
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
          'client_file_policy.write:not_owner',
        );
      }

      const value = body?.clientFiles;
      if (!isClientFilesPolicy(value)) {
        throw new ApiError(400, 'validation_failed', 'The request body is invalid', [
          { field: 'clientFiles', message: 'Choose checked or virus_scanned.' },
        ]);
      }

      const previous = await clientFilesPolicyOn(tx, context, this.scanner, this.settings);
      await this.settings.upsert(tx, context, {
        key: REQUIRE_SCAN_FOR_CLIENTS_KEY,
        value: storedClientFilesPolicy(value),
        updatedBy: principal.userId,
      });
      await this.audit.record(tx, context, {
        action: 'organization.client_file_policy_changed',
        objectId: context.organizationId,
        result: 'allowed',
        actorUserId: principal.userId,
        metadata: { previous, value },
      });
      return value;
    });
    return viewOf(next, hasScanner);
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
      `client_file_policy:${verdict.code}`,
    );
  }
}
