import {
  parseSignalSettingsInput,
  resolveSignalSettings,
  signalRulesVisibleTo,
} from '@tmanage/domain';
import type {
  Principal,
  SignalRecipient,
  SignalRuleKey,
  SignalThresholdUnit,
} from '@tmanage/domain';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import { ApiError } from '../../common/http/errors.js';
import type { AuditService } from '../audit/audit.service.js';
import type { SignalSettingsRepository } from './signals.repository.js';

/**
 * 62-27 (B05) — Settings → Alerts: the owner's choice per signal rule (on/off, threshold, who is
 * told). Owner only (FIGMA-D fix 29: "Only owners can change these rules"; anyone else is not
 * given the page). The money rules are listed only to a caller holding `finance.view`; an owner
 * holds it, so the filter is the domain's one rule, not a special case here.
 *
 * Off stops the notices only: the sweeper keeps filing the rule's signals for the Home briefing.
 * The routes exist only while `business_briefing` is on (the controller's `RequireFeature`).
 */

export interface SignalSettingView {
  readonly rule: SignalRuleKey;
  readonly enabled: boolean;
  readonly threshold: number;
  readonly recipient: SignalRecipient;
  readonly unit: SignalThresholdUnit;
  readonly min: number;
  readonly max: number;
  /** The recipient choices; a money rule has one, shown as fixed text, not a control. */
  readonly recipients: readonly SignalRecipient[];
  readonly money: boolean;
}

export interface SignalSettingsView {
  readonly rules: readonly SignalSettingView[];
}

export interface SignalSettingsServiceOptions {
  readonly database: TenantDatabase;
  readonly audit: Pick<AuditService, 'record'>;
  readonly repository: SignalSettingsRepository;
  readonly now?: () => Date;
}

export const SIGNAL_SETTINGS_AUDIT_ACTION = 'work_signal_settings.updated';

function requireOwner(principal: Principal): void {
  if (principal.kind !== 'internal' || principal.role !== 'owner') {
    throw new ApiError(
      403,
      'forbidden',
      'Only the company owner can change these rules.',
      undefined,
      'signal_settings:not_owner',
    );
  }
}

export class SignalSettingsService {
  private readonly now: () => Date;

  constructor(private readonly options: SignalSettingsServiceOptions) {
    this.now = options.now ?? (() => new Date());
  }

  async read(context: TenantContext, principal: Principal): Promise<SignalSettingsView> {
    requireOwner(principal);
    const rows = await this.options.database.read(context, (runner) =>
      this.options.repository.list(runner, context),
    );
    return viewOf(context, resolveSignalSettings(rows));
  }

  async update(
    context: TenantContext,
    principal: Principal,
    body: unknown,
  ): Promise<SignalSettingsView> {
    requireOwner(principal);
    const parsed = parseSignalSettingsInput(body);
    if (!parsed.ok) {
      throw new ApiError(400, 'validation_failed', 'The alert rules are not valid.', parsed.issues);
    }
    const visible = new Set(signalRulesVisibleTo(context.capabilities).map((rule) => rule.key));
    const hidden = parsed.settings.find((setting) => !visible.has(setting.rule));
    if (hidden !== undefined) {
      throw new ApiError(400, 'validation_failed', 'The alert rules are not valid.', [
        { field: 'rules', message: `${hidden.rule} is not a known rule` },
      ]);
    }
    const at = this.now();
    const rows = await this.options.database.transaction(context, async (tx) => {
      for (const setting of parsed.settings) {
        await this.options.repository.save(tx, context, setting, at);
      }
      await this.options.audit.record(tx, context, {
        action: SIGNAL_SETTINGS_AUDIT_ACTION,
        result: 'allowed',
        objectId: context.organizationId,
        actorUserId: context.userId,
        metadata: {
          rule_count: parsed.settings.length,
          rules: parsed.settings.map((setting) => setting.rule).join(','),
        },
      });
      return this.options.repository.list(tx, context);
    });
    return viewOf(context, resolveSignalSettings(rows));
  }
}

function viewOf(
  context: TenantContext,
  settings: ReturnType<typeof resolveSignalSettings>,
): SignalSettingsView {
  return {
    rules: signalRulesVisibleTo(context.capabilities).map((rule) => ({
      rule: rule.key,
      enabled: settings[rule.key].enabled,
      threshold: settings[rule.key].threshold,
      recipient: settings[rule.key].recipient,
      unit: rule.threshold.unit,
      min: rule.threshold.min,
      max: rule.threshold.max,
      recipients: rule.recipients,
      money: rule.money,
    })),
  };
}
