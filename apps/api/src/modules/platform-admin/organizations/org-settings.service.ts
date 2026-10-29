import type { TenantDatabase } from '../../../common/database/tenant-context.js';
import { ApiError } from '../../../common/http/errors.js';
import type { FeatureFlagsRepository } from '../../admin/feature-flags.repository.js';
import {
  DEFAULT_MODULE_ENABLED,
  isOptionalModuleFlag,
  OPTIONAL_MODULE_FLAGS,
} from '../../admin/feature-flags.service.js';
import {
  DEFAULT_POLICY,
  mergePolicy,
  normalizePolicy,
  validatePolicyPatch,
} from '../../admin/policies.allowlist.js';
import type { OrgPolicyValue } from '../../admin/policies.allowlist.js';
import type { PoliciesRepository } from '../../admin/policies.repository.js';
import {
  defaultFor,
  isOrgSettingKey,
  isOwnerOnlySettingKey,
  ORG_SETTING_KEYS,
  validateValue,
} from '../../tenancy/org-settings.allowlist.js';
import type { OrgSettingsRepository } from '../../tenancy/org-settings.repository.js';
import { acceptLogo, decodeLogoBase64 } from '../../tenancy/organization-logo-image.js';
import type { OrganizationLogoRepository } from '../../tenancy/organization-logo.repository.js';
import { optionalReason } from '../platform-admin.access.js';
import type { PlatformAdminActor } from '../platform-admin.guard.js';
import type { RequestContext } from '../platform-admin.service.js';
import { platformAuditFor } from '../platform-audit.service.js';
import { platformOrgContext } from './organizations.repository.js';
import type { OrgRow, PlatformOrganizationsRepository } from './organizations.repository.js';
import type {
  PlatformOrganizationsService,
  PlatformOrgWriteView,
} from './organizations.service.js';

/**
 * Platform admin · Organizations · Settings (A4; SPEC §6): the organization's own settings, access
 * policy and module flags, with the SAME allowlists and validators the owner's Admin screens use —
 * the operator acts through the application's rules, never around them (SPEC P1). Owner-only keys
 * are editable here too ("Owner-only · editable here"). Each change leaves a platform audit row.
 */

export interface PlatformOrgSettingView {
  readonly key: string;
  readonly value: string;
  readonly isDefault: boolean;
  readonly ownerOnly: boolean;
  readonly updatedAt: string | null;
}

export interface PlatformOrgFlagView {
  readonly key: string;
  readonly enabled: boolean;
  readonly isDefault: boolean;
  readonly platformDefault: boolean;
}

export interface PlatformOrgSettingsView {
  readonly settings: readonly PlatformOrgSettingView[];
  readonly policy: {
    readonly session_max_hours: number;
    readonly invite_domain_allowlist: readonly string[];
    readonly guest_access_enabled: boolean;
  };
  readonly flags: readonly PlatformOrgFlagView[];
  readonly hasLogo: boolean;
}

function refusal(field: string, message: string): ApiError {
  return new ApiError(400, 'validation_failed', message, [{ field, message }]);
}

export class PlatformOrganizationSettingsService {
  constructor(
    private readonly organizations: PlatformOrganizationsService,
    private readonly orgs: PlatformOrganizationsRepository,
    private readonly database: TenantDatabase,
    private readonly settings: OrgSettingsRepository,
    private readonly policies: PoliciesRepository,
    private readonly flags: FeatureFlagsRepository,
    private readonly logos: OrganizationLogoRepository,
  ) {}

  async view(rawId: unknown, context: RequestContext): Promise<PlatformOrgSettingsView> {
    const row = await this.organizations.require(rawId, context);
    const tenant = platformOrgContext(row.id, context.correlationId);
    const { stored, policy, flags, logo } = await this.database.read(tenant, async (db) => ({
      stored: await this.settings.listAll(db, tenant),
      policy: await this.policies.find(db, tenant),
      flags: await this.flags.list(db, tenant),
      logo: await this.logos.findInfo(db, tenant),
    }));
    const byKey = new Map(stored.map((setting) => [setting.settingKey, setting]));
    const flagByKey = new Map(flags.map((flag) => [flag.flagKey, flag]));
    const value: OrgPolicyValue = policy ? normalizePolicy(policy.policyJson) : DEFAULT_POLICY;
    return {
      settings: ORG_SETTING_KEYS.map((key) => {
        const setting = byKey.get(key);
        return {
          key,
          value: setting?.settingValue ?? defaultFor(key),
          isDefault: setting === undefined,
          ownerOnly: isOwnerOnlySettingKey(key),
          updatedAt: setting ? setting.updatedAt.toISOString() : null,
        };
      }),
      policy: {
        session_max_hours: value.session_max_hours,
        invite_domain_allowlist: [...value.invite_domain_allowlist],
        guest_access_enabled: value.guest_access_enabled,
      },
      flags: OPTIONAL_MODULE_FLAGS.map((key) => {
        const flag = flagByKey.get(key);
        const platformDefault = DEFAULT_MODULE_ENABLED[key];
        return {
          key,
          enabled: flag ? flag.enabled : platformDefault,
          isDefault: flag === undefined || flag.enabled === platformDefault,
          platformDefault,
        };
      }),
      hasLogo: logo !== null,
    };
  }

  async setSetting(
    actor: PlatformAdminActor,
    rawId: unknown,
    rawKey: unknown,
    body: { readonly value?: unknown; readonly reason?: unknown },
    context: RequestContext,
  ): Promise<PlatformOrgSettingsView> {
    const reason = optionalReason(body?.reason);
    const row = await this.organizations.require(rawId, context);
    if (typeof rawKey !== 'string' || !isOrgSettingKey(rawKey))
      throw refusal('key', 'That is not a setting we recognise.');
    const verdict = validateValue(rawKey, String(body?.value ?? ''));
    if (!verdict.ok) throw refusal('value', verdict.message);
    await this.orgs.write(
      row.id,
      audit(actor, context, row, 'platform.organization_settings_changed', reason, {
        key: rawKey,
        value: verdict.value,
      }),
      (tx, tenant) =>
        this.settings.upsert(tx, tenant, {
          key: rawKey,
          value: verdict.value,
          updatedBy: actor.account.userId,
        }),
    );
    return this.view(row.id, context);
  }

  async setPolicy(
    actor: PlatformAdminActor,
    rawId: unknown,
    body: Record<string, unknown>,
    context: RequestContext,
  ): Promise<PlatformOrgSettingsView> {
    const { reason: rawReason, ...patchBody } = body ?? {};
    const reason = optionalReason(rawReason);
    const row = await this.organizations.require(rawId, context);
    const verdict = validatePolicyPatch(patchBody);
    if (!verdict.ok) throw refusal(verdict.field, verdict.message);
    await this.orgs.write(
      row.id,
      audit(actor, context, row, 'platform.organization_policy_changed', reason, verdict.patch),
      async (tx, tenant) => {
        const current = await this.policies.find(tx, tenant);
        const base = current ? normalizePolicy(current.policyJson) : DEFAULT_POLICY;
        await this.policies.upsert(tx, tenant, {
          policy: mergePolicy(base, verdict.patch),
          updatedBy: actor.account.userId,
        });
      },
    );
    return this.view(row.id, context);
  }

  /** `enabled: null` returns the flag to the platform default (the row is set to it; never deleted). */
  async setFlag(
    actor: PlatformAdminActor,
    rawId: unknown,
    rawKey: unknown,
    body: { readonly enabled?: unknown; readonly reason?: unknown },
    context: RequestContext,
  ): Promise<PlatformOrgSettingsView> {
    const reason = optionalReason(body?.reason);
    const row = await this.organizations.require(rawId, context);
    if (!isOptionalModuleFlag(rawKey))
      throw refusal('flagKey', 'That is not a module we recognise.');
    const raw = body?.enabled;
    if (raw !== null && typeof raw !== 'boolean')
      throw refusal('enabled', 'Choose on, off or the platform default.');
    const enabled = raw === null ? DEFAULT_MODULE_ENABLED[rawKey] : raw;
    await this.orgs.write(
      row.id,
      audit(actor, context, row, 'platform.organization_flag_changed', reason, {
        flagKey: rawKey,
        enabled: raw,
      }),
      (tx, tenant) =>
        this.flags.upsert(tx, tenant, {
          flagKey: rawKey,
          enabled,
          updatedBy: actor.account.userId,
        }),
    );
    return this.view(row.id, context);
  }

  async setLogo(
    actor: PlatformAdminActor,
    rawId: unknown,
    body: {
      readonly mimeType?: unknown;
      readonly contentBase64?: unknown;
      readonly reason?: unknown;
    } | null,
    context: RequestContext,
  ): Promise<PlatformOrgWriteView> {
    const reason = optionalReason(body?.reason);
    const row = await this.organizations.require(rawId, context);
    const remove = body === null;
    let accepted: Extract<ReturnType<typeof acceptLogo>, { ok: true }> | null = null;
    if (!remove) {
      const bytes =
        typeof body?.contentBase64 === 'string' ? decodeLogoBase64(body.contentBase64) : null;
      if (!bytes) throw refusal('contentBase64', 'Choose an image file.');
      const verdict = acceptLogo(typeof body?.mimeType === 'string' ? body.mimeType : '', bytes);
      if (!verdict.ok) throw refusal('logo', verdict.message);
      accepted = verdict;
    }
    await this.orgs.write(
      row.id,
      audit(actor, context, row, 'platform.organization_updated', reason, {
        logo: remove ? 'removed' : 'replaced',
      }),
      (tx, tenant) =>
        accepted
          ? this.logos.upsert(tx, tenant, {
              mimeType: accepted.mimeType,
              sizeBytes: accepted.bytes.length,
              sha256: accepted.sha256,
              contentBase64: accepted.bytes.toString('base64'),
            })
          : this.logos.remove(tx, tenant),
    );
    return this.organizations.written(row.id, context);
  }
}

function audit(
  actor: PlatformAdminActor,
  context: RequestContext,
  row: OrgRow,
  action: string,
  reason: string | null,
  after: unknown,
) {
  return {
    ...platformAuditFor(actor, context, {
      action,
      targetType: 'organization' as const,
      targetId: row.id,
      targetLabel: row.name,
      organizationId: row.id,
      reason,
    }),
    afterJson: JSON.stringify(after),
  };
}
