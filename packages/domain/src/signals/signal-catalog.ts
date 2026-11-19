import type { Capability } from '../policies/capabilities.js';

/**
 * 62-27 + 62-A1a — the signals engine's catalogue: the eight rules, what each one measures, its
 * threshold limits and who may be told. One list for the worker (which raises signals), the API
 * (owner settings) and the Home briefing (62-A1b), so a notice badge, a rule and a briefing group
 * always pair the same way (FIGMA-D fix 22).
 *
 * Every rule is a row-and-threshold rule; no rule calls a model (plan 62 §4.7).
 *
 * ## Money rules reach finance only (FIGMA-D fix 23–24)
 *
 * Overdue invoice, project over budget, unusual expense and approved time not invoiced are money
 * rules: only people with `finance.view` are told and only they see the rule. Their recipient is
 * not a choice; the one allowed value is fixed ("Finance team", over budget "Owner and finance
 * team").
 */

export const SIGNAL_RULE_KEYS = [
  'deadline_at_risk',
  'overloaded_person',
  'overdue_invoice',
  'project_over_budget',
  'stale_task',
  'unusual_expense',
  'approval_waiting_on_client',
  'approved_time_not_invoiced',
] as const;

export type SignalRuleKey = (typeof SIGNAL_RULE_KEYS)[number];

/** Who is told — one fixed choice per rule (FIGMA-D fix 24: a select, not free text). */
export const SIGNAL_RECIPIENTS = [
  'project_lead',
  'their_manager',
  'assignee',
  'owner',
  'project_lead_and_owner',
  'finance_team',
  'owner_and_finance_team',
] as const;

export type SignalRecipient = (typeof SIGNAL_RECIPIENTS)[number];

/** The unit after the threshold number (FIGMA-D fix 25: the unit is outside the editable part). */
export const SIGNAL_THRESHOLD_UNITS = [
  'days_before',
  'percent_of_capacity',
  'days_overdue',
  'percent_of_budget',
  'days',
  'times_usual',
] as const;

export type SignalThresholdUnit = (typeof SIGNAL_THRESHOLD_UNITS)[number];

/** The row a signal is about. */
export const SIGNAL_SUBJECT_TYPES = [
  'work_item',
  'membership',
  'client_invoice',
  'project',
  'expense',
  'approval',
] as const;

export type SignalSubjectType = (typeof SIGNAL_SUBJECT_TYPES)[number];

/** The Home briefing group a rule's signals are listed under (62-A1b, plural list names). */
export const SIGNAL_BRIEFING_GROUPS = [
  'projects_at_risk',
  'people_overloaded',
  'money_to_collect',
  'over_budget',
  'stale_work',
  'unusual_expenses',
  'waiting_on_clients',
  'money_to_invoice',
] as const;

export type SignalBriefingGroup = (typeof SIGNAL_BRIEFING_GROUPS)[number];

export interface SignalThresholdSpec {
  readonly unit: SignalThresholdUnit;
  readonly defaultValue: number;
  readonly min: number;
  readonly max: number;
}

export interface SignalRuleDefinition {
  readonly key: SignalRuleKey;
  readonly subjectType: SignalSubjectType;
  readonly briefingGroup: SignalBriefingGroup;
  /** A money rule: told to and visible to `finance.view` holders only. */
  readonly money: boolean;
  readonly threshold: SignalThresholdSpec;
  /** The choices the owner may pick from; a money rule has exactly one. */
  readonly recipients: readonly [SignalRecipient, ...SignalRecipient[]];
  readonly defaultRecipient: SignalRecipient;
}

const TASK_RECIPIENTS = [
  'project_lead',
  'their_manager',
  'assignee',
  'owner',
  'project_lead_and_owner',
] as const satisfies readonly SignalRecipient[];

/** The capability a money rule needs, to be told and to see the rule. */
export const SIGNAL_FINANCE_CAPABILITY: Capability = 'finance.view';

export const SIGNAL_RULES: Readonly<Record<SignalRuleKey, SignalRuleDefinition>> = {
  deadline_at_risk: {
    key: 'deadline_at_risk',
    subjectType: 'work_item',
    briefingGroup: 'projects_at_risk',
    money: false,
    threshold: { unit: 'days_before', defaultValue: 5, min: 1, max: 30 },
    recipients: TASK_RECIPIENTS,
    defaultRecipient: 'project_lead',
  },
  overloaded_person: {
    key: 'overloaded_person',
    subjectType: 'membership',
    briefingGroup: 'people_overloaded',
    money: false,
    threshold: { unit: 'percent_of_capacity', defaultValue: 110, min: 100, max: 300 },
    recipients: ['their_manager', 'owner'],
    defaultRecipient: 'their_manager',
  },
  overdue_invoice: {
    key: 'overdue_invoice',
    subjectType: 'client_invoice',
    briefingGroup: 'money_to_collect',
    money: true,
    threshold: { unit: 'days_overdue', defaultValue: 7, min: 1, max: 90 },
    recipients: ['finance_team'],
    defaultRecipient: 'finance_team',
  },
  project_over_budget: {
    key: 'project_over_budget',
    subjectType: 'project',
    briefingGroup: 'over_budget',
    money: true,
    threshold: { unit: 'percent_of_budget', defaultValue: 100, min: 50, max: 300 },
    recipients: ['owner_and_finance_team'],
    defaultRecipient: 'owner_and_finance_team',
  },
  stale_task: {
    key: 'stale_task',
    subjectType: 'work_item',
    briefingGroup: 'stale_work',
    money: false,
    threshold: { unit: 'days', defaultValue: 14, min: 1, max: 180 },
    recipients: TASK_RECIPIENTS,
    defaultRecipient: 'assignee',
  },
  unusual_expense: {
    key: 'unusual_expense',
    subjectType: 'expense',
    briefingGroup: 'unusual_expenses',
    money: true,
    threshold: { unit: 'times_usual', defaultValue: 3, min: 2, max: 20 },
    recipients: ['finance_team'],
    defaultRecipient: 'finance_team',
  },
  approval_waiting_on_client: {
    key: 'approval_waiting_on_client',
    subjectType: 'approval',
    briefingGroup: 'waiting_on_clients',
    money: false,
    threshold: { unit: 'days', defaultValue: 3, min: 1, max: 60 },
    recipients: ['project_lead', 'owner', 'project_lead_and_owner'],
    defaultRecipient: 'project_lead',
  },
  approved_time_not_invoiced: {
    key: 'approved_time_not_invoiced',
    subjectType: 'project',
    briefingGroup: 'money_to_invoice',
    money: true,
    threshold: { unit: 'days', defaultValue: 14, min: 1, max: 120 },
    recipients: ['finance_team'],
    defaultRecipient: 'finance_team',
  },
};

const RULE_KEY_SET: ReadonlySet<string> = new Set(SIGNAL_RULE_KEYS);

export function isSignalRuleKey(value: unknown): value is SignalRuleKey {
  return typeof value === 'string' && RULE_KEY_SET.has(value);
}

export function isSignalRecipient(value: unknown): value is SignalRecipient {
  return typeof value === 'string' && (SIGNAL_RECIPIENTS as readonly string[]).includes(value);
}

/**
 * The rules a person may see: every non-money rule, and the money rules only with
 * {@link SIGNAL_FINANCE_CAPABILITY}. Catalogue order.
 */
export function signalRulesVisibleTo(
  capabilities: readonly Capability[],
): readonly SignalRuleDefinition[] {
  const finance = capabilities.includes(SIGNAL_FINANCE_CAPABILITY);
  return SIGNAL_RULE_KEYS.map((key) => SIGNAL_RULES[key]).filter((rule) => !rule.money || finance);
}
