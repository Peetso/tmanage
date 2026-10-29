import { ApiError } from '../../../common/http/errors.js';
import { parseBillingMode } from '../../billing/billing-mode.js';
import type { BillingMode } from '../../billing/billing-mode.js';
import {
  environmentAiDisabled,
  PLATFORM_AI_ACCESS_SETTING,
  platformAiAccessOn,
} from '../../oauth/ai-access.js';
import {
  PLATFORM_STEP_UP_MINUTES,
  optionalReason,
  requireReason,
} from '../platform-admin.access.js';
import type { PlatformAdminActor } from '../platform-admin.guard.js';
import type { PlatformAdminRepository, PlatformAuditInput } from '../platform-admin.repository.js';
import type { PlatformSettingsView, RequestContext } from '../platform-admin.service.js';
import { platformAuditFor } from '../platform-audit.service.js';
import { PUBLIC_SIGNUP_SETTING, publicSignupFromSetting } from '../platform-settings.js';
import { IntegrationsService } from './integrations.service.js';
import type { PlatformIntegrationsView } from './integrations.service.js';
import type { PlatformSettingsRepository, StoredSetting } from './settings.repository.js';

/**
 * Platform admin · Settings — D1 General (SPEC §4 D1, §5.6, §6 0246's `platform_settings` rows).
 *
 * Every switch has a code or environment default; a stored row overrides it and is recorded with
 * the operator's name. The view says where each value comes from (`source`): `environment` (the
 * Hostinger variable, or the code default when there is none) or `platform_setting` (saved here).
 *
 * This service only WRITES the rows. The readers live with their features: PA-07's
 * `billingMode()` reads `billing_mode`, PA-03's purge window reads `retention.*`, PA-05's support
 * sessions read `support.*`, the AI switch reads `ai_access`.
 *
 * Reason: required for billing mode and the integration switches (SPEC P6), optional elsewhere.
 * The sign-up and AI switches keep their wave-9 rule (reason required), unchanged by the split.
 */

// ── platform_settings keys (SPEC §6 0246) ─────────────────────────────────────

export const BILLING_MODE_SETTING = 'billing_mode';
export const BETA_BANNER_EN_SETTING = 'beta_banner_en';
export const BETA_BANNER_AR_SETTING = 'beta_banner_ar';
export const BETA_BANNER_ON_SETTING = 'beta_banner_on';
export const RETENTION_ORG_SETTING = 'retention.org_purge_days';
export const RETENTION_USER_SETTING = 'retention.user_purge_days';
export const RETENTION_CONTENT_SETTING = 'retention.content_purge_days';
export const SUPPORT_MAX_MINUTES_SETTING = 'support.max_minutes';
export const SUPPORT_REQUIRE_REASON_SETTING = 'support.require_reason';

export const RETENTION_DEFAULT_DAYS = 30;
export const RETENTION_MIN_DAYS = 1;
export const RETENTION_MAX_DAYS = 365;
export const SUPPORT_MAX_MINUTES_DEFAULT = 480;
export const SUPPORT_MAX_MINUTES_CEILING = 480;
export const SUPPORT_MAX_MINUTES_FLOOR = 15;
export const BANNER_TEXT_MAX = 255;

/** The rows the page seeds from code on first read (no DDL): retention and support defaults. */
export const SEEDED_SETTINGS: ReadonlyMap<string, string> = new Map([
  [RETENTION_ORG_SETTING, String(RETENTION_DEFAULT_DAYS)],
  [RETENTION_USER_SETTING, String(RETENTION_DEFAULT_DAYS)],
  [RETENTION_CONTENT_SETTING, String(RETENTION_DEFAULT_DAYS)],
  [SUPPORT_MAX_MINUTES_SETTING, String(SUPPORT_MAX_MINUTES_DEFAULT)],
  [SUPPORT_REQUIRE_REASON_SETTING, 'false'],
]);

export type PlatformSettingSource = 'environment' | 'platform_setting';

/** Who changed a section last, and when (`null` when it was never saved here). */
export interface PlatformSettingChangeView {
  readonly at: string | null;
  readonly by: string | null;
}

/** `GET /v1/platform/settings` — the whole D1 page. Extends the wave-9 view without changing it. */
export interface PlatformSettingsFullView extends PlatformSettingsView {
  readonly billingMode: {
    readonly mode: BillingMode;
    readonly source: PlatformSettingSource;
    readonly environmentDefault: BillingMode;
    readonly organizationCount: number;
    /** Organizations with their own billing mode (0243); `null` before PA-07's column exists. */
    readonly overrideCount: number | null;
  };
  readonly betaBanner: {
    readonly on: boolean;
    readonly textEn: string;
    readonly textAr: string;
  };
  readonly retention: {
    readonly orgPurgeDays: number;
    readonly userPurgeDays: number;
    readonly contentPurgeDays: number;
  };
  readonly supportDefaults: {
    readonly maxMinutes: number;
    readonly requireReason: boolean;
  };
  /** Fixed by safety rule 8; shown read-only. */
  readonly stepUpMinutes: number;
  readonly changes: {
    readonly publicSignup: PlatformSettingChangeView;
    readonly aiAccess: PlatformSettingChangeView;
    readonly billingMode: PlatformSettingChangeView;
    readonly betaBanner: PlatformSettingChangeView;
    readonly retention: PlatformSettingChangeView;
    readonly supportDefaults: PlatformSettingChangeView;
  };
}

type Body = Readonly<Record<string, unknown>>;

/** What the service needs besides the PA-02 repository. Optional so the wave-9 tests still fit. */
export interface PlatformSettingsDeps {
  readonly store: PlatformSettingsRepository;
  readonly environment?: NodeJS.ProcessEnv;
}

/** A whole number within bounds, or a 400 naming the field. */
export function boundedInteger(value: unknown, field: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw new ApiError(400, 'validation_failed', `Choose a value from ${min} to ${max}.`, [
      { field, message: `whole number ${min}–${max}` },
    ]);
  }
  return value;
}

function storedInteger(
  stored: StoredSetting | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  const parsed = Number(stored?.value);
  return Number.isInteger(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
}

function latest(...settings: (StoredSetting | undefined)[]): PlatformSettingChangeView {
  let best: StoredSetting | undefined;
  for (const setting of settings) {
    if (!setting?.updatedAt) continue;
    if (!best?.updatedAt || setting.updatedAt.getTime() > best.updatedAt.getTime()) best = setting;
  }
  return { at: best?.updatedAt?.toISOString() ?? null, by: best?.updatedBy ?? null };
}

function asBillingMode(value: unknown): BillingMode {
  if (value === 'beta_free' || value === 'paid') return value;
  throw new ApiError(400, 'validation_failed', 'Choose beta_free or paid.', [
    { field: 'mode', message: 'one of beta_free, paid' },
  ]);
}

function bannerText(value: unknown, field: string): string {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string' || value.trim().length > BANNER_TEXT_MAX) {
    throw new ApiError(400, 'validation_failed', 'The banner text is too long.', [
      { field, message: `at most ${BANNER_TEXT_MAX} characters` },
    ]);
  }
  return value.trim();
}

export class PlatformSettingsService {
  private readonly integrationsService: IntegrationsService | null;

  constructor(
    private readonly repository: PlatformAdminRepository,
    private readonly publicSignupDefault: boolean,
    private readonly deps?: PlatformSettingsDeps,
  ) {
    this.integrationsService = deps
      ? new IntegrationsService(deps.store, repository, deps.environment)
      : null;
  }

  private get env(): NodeJS.ProcessEnv {
    return this.deps?.environment ?? process.env;
  }

  /** The wave-9 view (sign-up + AI), or the whole page when the settings store is wired. */
  async settings(
    context: RequestContext,
  ): Promise<PlatformSettingsView | PlatformSettingsFullView> {
    if (this.deps) return this.fullSettings(context);
    const stored = await this.repository.readSetting(PUBLIC_SIGNUP_SETTING, context.correlationId);
    const ai = await this.repository.readSetting(PLATFORM_AI_ACCESS_SETTING, context.correlationId);
    return this.settingsView(stored, ai);
  }

  async fullSettings(context: RequestContext): Promise<PlatformSettingsFullView> {
    const store = this.requireStore();
    await store.seed(SEEDED_SETTINGS, context.correlationId);
    const rows = await store.readAll(context.correlationId);
    const counts = await store.organizationCounts(context.correlationId);
    return buildFullView(rows, counts, this.publicSignupDefault, this.env);
  }

  async integrations(context: RequestContext): Promise<PlatformIntegrationsView> {
    return this.requireIntegrations().list(context);
  }

  /** S11: turn every AI app off (or back on) for the whole platform. Audited with a reason. */
  async setAiAccess(
    actor: PlatformAdminActor,
    body: { readonly on?: unknown; readonly reason?: unknown },
    context: RequestContext,
  ): Promise<PlatformSettingsView> {
    if (typeof body?.on !== 'boolean') {
      throw new ApiError(400, 'validation_failed', 'Choose on or off.', [
        { field: 'on', message: 'must be a boolean' },
      ]);
    }
    const reason = requireReason(body?.reason);
    await this.repository.writeSetting(
      PLATFORM_AI_ACCESS_SETTING,
      body.on ? 'on' : 'off',
      platformAuditFor(actor, context, {
        action: body.on ? 'platform.ai_access_on' : 'platform.ai_access_off',
        targetType: 'setting',
        targetId: null,
        targetLabel: PLATFORM_AI_ACCESS_SETTING,
        reason,
      }),
    );
    return this.settings(context);
  }

  async setPublicSignup(
    actor: PlatformAdminActor,
    body: { readonly open?: unknown; readonly reason?: unknown },
    context: RequestContext,
  ): Promise<PlatformSettingsView> {
    if (typeof body?.open !== 'boolean') {
      throw new ApiError(400, 'validation_failed', 'Choose open or closed.', [
        { field: 'open', message: 'must be a boolean' },
      ]);
    }
    const reason = requireReason(body?.reason);
    const value = body.open ? 'open' : 'closed';
    await this.repository.writeSetting(
      PUBLIC_SIGNUP_SETTING,
      value,
      platformAuditFor(actor, context, {
        action: body.open ? 'platform.public_signup_opened' : 'platform.public_signup_closed',
        targetType: 'setting',
        targetId: null,
        targetLabel: PUBLIC_SIGNUP_SETTING,
        reason,
      }),
    );
    return this.settings(context);
  }

  /** `PUT settings/billing-mode {mode, reason}` — reason REQUIRED (SPEC P6). */
  async setBillingMode(
    actor: PlatformAdminActor,
    body: Body,
    context: RequestContext,
  ): Promise<PlatformSettingsFullView> {
    const mode = asBillingMode(body?.['mode']);
    const reason = requireReason(body?.['reason']);
    const before = await this.fullSettings(context);
    await this.requireStore().writeMany(
      [[BILLING_MODE_SETTING, mode]],
      this.audit(actor, context, {
        action: 'platform.billing_mode_changed',
        targetLabel: BILLING_MODE_SETTING,
        reason,
        before: { mode: before.billingMode.mode },
        after: { mode },
      }),
    );
    return this.fullSettings(context);
  }

  /** `PUT settings/beta-banner {textEn, textAr, on}` — reason optional. */
  async setBetaBanner(
    actor: PlatformAdminActor,
    body: Body,
    context: RequestContext,
  ): Promise<PlatformSettingsFullView> {
    if (typeof body?.['on'] !== 'boolean') {
      throw new ApiError(400, 'validation_failed', 'Choose on or off.', [
        { field: 'on', message: 'must be a boolean' },
      ]);
    }
    const on = body['on'];
    const textEn = bannerText(body['textEn'], 'textEn');
    const textAr = bannerText(body['textAr'], 'textAr');
    if (on && textEn === '') {
      throw new ApiError(400, 'validation_failed', 'Write the English banner text first.', [
        { field: 'textEn', message: 'required while the banner is on' },
      ]);
    }
    const reason = optionalReason(body['reason']);
    const before = await this.fullSettings(context);
    await this.requireStore().writeMany(
      [
        [BETA_BANNER_ON_SETTING, on ? 'true' : 'false'],
        [BETA_BANNER_EN_SETTING, textEn],
        [BETA_BANNER_AR_SETTING, textAr],
      ],
      this.audit(actor, context, {
        action: 'platform.beta_banner_updated',
        targetLabel: 'beta_banner',
        reason,
        before: before.betaBanner,
        after: { on, textEn, textAr },
      }),
    );
    return this.fullSettings(context);
  }

  /** `PUT settings/retention {orgPurgeDays, userPurgeDays, contentPurgeDays}` — 1..365 days. */
  async setRetention(
    actor: PlatformAdminActor,
    body: Body,
    context: RequestContext,
  ): Promise<PlatformSettingsFullView> {
    const orgPurgeDays = boundedInteger(
      body?.['orgPurgeDays'],
      'orgPurgeDays',
      RETENTION_MIN_DAYS,
      RETENTION_MAX_DAYS,
    );
    const userPurgeDays = boundedInteger(
      body?.['userPurgeDays'],
      'userPurgeDays',
      RETENTION_MIN_DAYS,
      RETENTION_MAX_DAYS,
    );
    const contentPurgeDays = boundedInteger(
      body?.['contentPurgeDays'],
      'contentPurgeDays',
      RETENTION_MIN_DAYS,
      RETENTION_MAX_DAYS,
    );
    const reason = optionalReason(body?.['reason']);
    const before = await this.fullSettings(context);
    await this.requireStore().writeMany(
      [
        [RETENTION_ORG_SETTING, String(orgPurgeDays)],
        [RETENTION_USER_SETTING, String(userPurgeDays)],
        [RETENTION_CONTENT_SETTING, String(contentPurgeDays)],
      ],
      this.audit(actor, context, {
        action: 'platform.retention_updated',
        targetLabel: 'retention',
        reason,
        before: before.retention,
        after: { orgPurgeDays, userPurgeDays, contentPurgeDays },
      }),
    );
    return this.fullSettings(context);
  }

  /** `PUT settings/support-defaults {maxMinutes, requireReason}` — at most 480 minutes. */
  async setSupportDefaults(
    actor: PlatformAdminActor,
    body: Body,
    context: RequestContext,
  ): Promise<PlatformSettingsFullView> {
    const maxMinutes = boundedInteger(
      body?.['maxMinutes'],
      'maxMinutes',
      SUPPORT_MAX_MINUTES_FLOOR,
      SUPPORT_MAX_MINUTES_CEILING,
    );
    if (typeof body?.['requireReason'] !== 'boolean') {
      throw new ApiError(400, 'validation_failed', 'Choose yes or no.', [
        { field: 'requireReason', message: 'must be a boolean' },
      ]);
    }
    const requireReasonToEnter = body['requireReason'];
    const reason = optionalReason(body['reason']);
    const before = await this.fullSettings(context);
    await this.requireStore().writeMany(
      [
        [SUPPORT_MAX_MINUTES_SETTING, String(maxMinutes)],
        [SUPPORT_REQUIRE_REASON_SETTING, requireReasonToEnter ? 'true' : 'false'],
      ],
      this.audit(actor, context, {
        action: 'platform.support_defaults_updated',
        targetLabel: 'support',
        reason,
        before: before.supportDefaults,
        after: { maxMinutes, requireReason: requireReasonToEnter },
      }),
    );
    return this.fullSettings(context);
  }

  /** `PUT settings/integrations/:integration {enabled, reason}` — reason REQUIRED. */
  async setIntegration(
    actor: PlatformAdminActor,
    integration: string,
    body: Body,
    context: RequestContext,
  ): Promise<PlatformIntegrationsView> {
    return this.requireIntegrations().setEnabled(actor, integration, body, context);
  }

  private audit(
    actor: PlatformAdminActor,
    context: RequestContext,
    fields: {
      action: string;
      targetLabel: string;
      reason: string | null;
      before: unknown;
      after: unknown;
    },
  ): PlatformAuditInput {
    return platformAuditFor(actor, context, {
      action: fields.action,
      targetType: 'setting',
      targetId: null,
      targetLabel: fields.targetLabel,
      reason: fields.reason,
      beforeJson: JSON.stringify(fields.before),
      afterJson: JSON.stringify(fields.after),
    });
  }

  private requireStore(): PlatformSettingsRepository {
    if (!this.deps) throw new Error('PlatformSettingsService built without its settings store');
    return this.deps.store;
  }

  private requireIntegrations(): IntegrationsService {
    if (!this.integrationsService) {
      throw new Error('PlatformSettingsService built without its settings store');
    }
    return this.integrationsService;
  }

  private settingsView(stored: string | null, aiStored: string | null): PlatformSettingsView {
    const environmentDisabled = environmentAiDisabled(this.env['TMANAGE_MCP_DISABLED']);
    return {
      aiAccess: {
        on: platformAiAccessOn(aiStored, environmentDisabled),
        environmentDisabled,
      },
      publicSignup: {
        open: publicSignupFromSetting(stored, this.publicSignupDefault),
        source: stored === null ? ('environment' as const) : ('platform_setting' as const),
        environmentDefault: this.publicSignupDefault,
      },
    };
  }
}

/** The whole D1 view from the stored rows and the environment. Pure, so it is unit-testable. */
export function buildFullView(
  rows: ReadonlyMap<string, StoredSetting>,
  counts: { readonly total: number; readonly billingOverrides: number | null },
  publicSignupDefault: boolean,
  env: NodeJS.ProcessEnv,
): PlatformSettingsFullView {
  const signup = rows.get(PUBLIC_SIGNUP_SETTING);
  const ai = rows.get(PLATFORM_AI_ACCESS_SETTING);
  const billing = rows.get(BILLING_MODE_SETTING);
  const environmentDisabled = environmentAiDisabled(env['TMANAGE_MCP_DISABLED']);
  const environmentBilling = parseBillingMode(env['BILLING_MODE']);
  const storedBilling =
    billing?.value === 'paid' || billing?.value === 'beta_free' ? billing.value : null;
  const bannerOn = rows.get(BETA_BANNER_ON_SETTING);
  const bannerEn = rows.get(BETA_BANNER_EN_SETTING);
  const bannerAr = rows.get(BETA_BANNER_AR_SETTING);
  const retentionRows = [
    rows.get(RETENTION_ORG_SETTING),
    rows.get(RETENTION_USER_SETTING),
    rows.get(RETENTION_CONTENT_SETTING),
  ] as const;
  const supportMax = rows.get(SUPPORT_MAX_MINUTES_SETTING);
  const supportReason = rows.get(SUPPORT_REQUIRE_REASON_SETTING);
  return {
    publicSignup: {
      open: publicSignupFromSetting(signup?.value ?? null, publicSignupDefault),
      source: signup === undefined ? 'environment' : 'platform_setting',
      environmentDefault: publicSignupDefault,
    },
    aiAccess: {
      on: platformAiAccessOn(ai?.value ?? null, environmentDisabled),
      environmentDisabled,
    },
    billingMode: {
      mode: storedBilling ?? environmentBilling,
      source: storedBilling === null ? 'environment' : 'platform_setting',
      environmentDefault: environmentBilling,
      organizationCount: counts.total,
      overrideCount: counts.billingOverrides,
    },
    betaBanner: {
      on: bannerOn?.value === 'true',
      textEn: bannerEn?.value ?? '',
      textAr: bannerAr?.value ?? '',
    },
    retention: {
      orgPurgeDays: storedInteger(
        retentionRows[0],
        RETENTION_DEFAULT_DAYS,
        RETENTION_MIN_DAYS,
        RETENTION_MAX_DAYS,
      ),
      userPurgeDays: storedInteger(
        retentionRows[1],
        RETENTION_DEFAULT_DAYS,
        RETENTION_MIN_DAYS,
        RETENTION_MAX_DAYS,
      ),
      contentPurgeDays: storedInteger(
        retentionRows[2],
        RETENTION_DEFAULT_DAYS,
        RETENTION_MIN_DAYS,
        RETENTION_MAX_DAYS,
      ),
    },
    supportDefaults: {
      maxMinutes: storedInteger(
        supportMax,
        SUPPORT_MAX_MINUTES_DEFAULT,
        SUPPORT_MAX_MINUTES_FLOOR,
        SUPPORT_MAX_MINUTES_CEILING,
      ),
      requireReason: supportReason?.value === 'true',
    },
    stepUpMinutes: PLATFORM_STEP_UP_MINUTES,
    changes: {
      publicSignup: latest(signup),
      aiAccess: latest(ai),
      billingMode: latest(billing),
      betaBanner: latest(bannerOn, bannerEn, bannerAr),
      retention: latest(...retentionRows),
      supportDefaults: latest(supportMax, supportReason),
    },
  };
}
