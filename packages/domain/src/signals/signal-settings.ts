import {
  SIGNAL_RULE_KEYS,
  SIGNAL_RULES,
  isSignalRecipient,
  isSignalRuleKey,
} from './signal-catalog.js';
import type { SignalRecipient, SignalRuleKey } from './signal-catalog.js';

/**
 * The owner's per-rule settings (`work_signal_settings`): on/off, threshold, who is told. A rule
 * without a stored row runs on its catalogue defaults, on.
 *
 * Off stops the notices only (FIGMA-D fix 27): the sweeper still records the signal with the same
 * threshold, so the Home briefing keeps showing it.
 */

export interface SignalRuleSetting {
  readonly rule: SignalRuleKey;
  readonly enabled: boolean;
  readonly threshold: number;
  readonly recipient: SignalRecipient;
}

/** One stored row as read; values outside the catalogue fall back to the default, field by field. */
export interface StoredSignalSetting {
  readonly rule: string;
  readonly enabled: boolean;
  readonly threshold: number;
  readonly recipient: string;
}

export function defaultSignalSetting(rule: SignalRuleKey): SignalRuleSetting {
  const definition = SIGNAL_RULES[rule];
  return {
    rule,
    enabled: true,
    threshold: definition.threshold.defaultValue,
    recipient: definition.defaultRecipient,
  };
}

function thresholdAllowed(rule: SignalRuleKey, value: unknown): value is number {
  const { min, max } = SIGNAL_RULES[rule].threshold;
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;
}

function recipientAllowed(rule: SignalRuleKey, value: unknown): value is SignalRecipient {
  return (
    isSignalRecipient(value) && (SIGNAL_RULES[rule].recipients as readonly string[]).includes(value)
  );
}

/** Every rule's setting in catalogue order: the stored row where it is valid, else the default. */
export function resolveSignalSettings(
  rows: readonly StoredSignalSetting[],
): Readonly<Record<SignalRuleKey, SignalRuleSetting>> {
  const stored = new Map(rows.filter((row) => isSignalRuleKey(row.rule)).map((r) => [r.rule, r]));
  const resolved = {} as Record<SignalRuleKey, SignalRuleSetting>;
  for (const rule of SIGNAL_RULE_KEYS) {
    const fallback = defaultSignalSetting(rule);
    const row = stored.get(rule);
    resolved[rule] =
      row === undefined
        ? fallback
        : {
            rule,
            enabled: row.enabled,
            threshold: thresholdAllowed(rule, row.threshold) ? row.threshold : fallback.threshold,
            recipient: recipientAllowed(rule, row.recipient) ? row.recipient : fallback.recipient,
          };
  }
  return resolved;
}

export interface SignalSettingIssue {
  readonly field: string;
  readonly message: string;
}

export type SignalSettingsParse =
  | { readonly ok: true; readonly settings: readonly SignalRuleSetting[] }
  | { readonly ok: false; readonly issues: readonly SignalSettingIssue[] };

/**
 * Parse a settings save: `{ rules: [{ rule, enabled, threshold, recipient }] }`, each rule at most
 * once, every field required, the threshold a whole number inside the rule's limits and the
 * recipient one of the rule's choices. Anything else is refused whole; nothing is half-saved.
 */
export function parseSignalSettingsInput(body: unknown): SignalSettingsParse {
  const issues: SignalSettingIssue[] = [];
  const list =
    body !== null && typeof body === 'object' ? (body as Record<string, unknown>)['rules'] : null;
  if (!Array.isArray(list) || list.length === 0 || list.length > SIGNAL_RULE_KEYS.length) {
    return { ok: false, issues: [{ field: 'rules', message: 'must list 1 to 8 rules' }] };
  }
  const seen = new Set<string>();
  const settings: SignalRuleSetting[] = [];
  list.forEach((entry: unknown, index) => {
    const at = `rules[${String(index)}]`;
    const item =
      entry !== null && typeof entry === 'object' ? (entry as Record<string, unknown>) : {};
    const rule = item['rule'];
    if (!isSignalRuleKey(rule)) {
      issues.push({ field: `${at}.rule`, message: 'is not a known rule' });
      return;
    }
    if (seen.has(rule)) {
      issues.push({ field: `${at}.rule`, message: 'is listed twice' });
      return;
    }
    seen.add(rule);
    const { enabled, threshold, recipient } = item;
    if (typeof enabled !== 'boolean')
      issues.push({ field: `${at}.enabled`, message: 'must be true or false' });
    if (!thresholdAllowed(rule, threshold)) {
      const { min, max } = SIGNAL_RULES[rule].threshold;
      issues.push({
        field: `${at}.threshold`,
        message: `must be a whole number from ${String(min)} to ${String(max)}`,
      });
    }
    if (!recipientAllowed(rule, recipient)) {
      issues.push({ field: `${at}.recipient`, message: 'is not a choice for this rule' });
    }
    if (
      typeof enabled === 'boolean' &&
      thresholdAllowed(rule, threshold) &&
      recipientAllowed(rule, recipient)
    ) {
      settings.push({ rule, enabled, threshold, recipient });
    }
  });
  return issues.length > 0 ? { ok: false, issues } : { ok: true, settings };
}
