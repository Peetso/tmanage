import type { SignalRecipient, SignalRuleKey, SignalThresholdUnit } from '../../lib/api/signals';

/**
 * 62-27 (B12) — every word Settings → Alerts draws, in one place (FIGMA-D group c). The keys reach
 * `en.json` / `ar.json` through the wiring step (B12-REPORT, WIRING); until then `tOr` returns the
 * English given here, never a raw key. `{name}` holes are filled after the translation.
 */
export const ALERTS_COPY = {
  'AlertSettings.crumb': 'Alerts',
  'AlertSettings.title': 'Alerts',
  'AlertSettings.lead':
    'TManage checks your company’s work every hour and tells the right person when something needs attention. One notice per subject a day. Only owners can change these rules.',
  'AlertSettings.loading': 'Loading the alert rules',
  'AlertSettings.loadFailed': 'Could not load the alert rules.',
  'AlertSettings.off': 'Alerts are not turned on for this company.',
  'AlertSettings.ownerOnly': 'Only the company owner can change these rules.',
  'AlertSettings.columnRule': 'Rule',
  'AlertSettings.columnThreshold': 'Threshold',
  'AlertSettings.columnRecipient': 'Who is told',
  'AlertSettings.fieldLabel': '{rule}, {column}',
  'AlertSettings.financeOnly': 'Only people with finance access are told.',
  'AlertSettings.offMeans':
    'A rule that is off sends no notices. The business briefing on Home still shows it.',
  'AlertSettings.thresholdError': 'Enter a whole number from {min} to {max}.',
  'AlertSettings.save': 'Save changes',
  'AlertSettings.saving': 'Saving…',
  'AlertSettings.cancel': 'Cancel',
  'AlertSettings.saved': 'Alert rules saved',
  'AlertSettings.saveFailed': 'Could not save the alert rules.',
  'AlertSettings.dismiss': 'Dismiss',
  'AlertSettings.leaveBody': 'You changed {count} alert rules. They are not saved yet.',
  'AlertSettings.leaveBodyOne': 'You changed one alert rule. It is not saved yet.',

  'AlertSettings.rule.deadline_at_risk': 'Task late or at risk',
  'AlertSettings.rule.overloaded_person': 'Overloaded person',
  'AlertSettings.rule.overdue_invoice': 'Overdue invoice',
  'AlertSettings.rule.project_over_budget': 'Project over budget',
  'AlertSettings.rule.stale_task': 'Stale task',
  'AlertSettings.rule.unusual_expense': 'Unusual expense',
  'AlertSettings.rule.approval_waiting_on_client': 'Approval waiting on the client',
  'AlertSettings.rule.approved_time_not_invoiced': 'Approved time not invoiced',

  'AlertSettings.meaning.deadline_at_risk':
    'A task is past due, or due soon with more work left than time',
  'AlertSettings.meaning.overloaded_person': 'Planned hours go over the person’s capacity',
  'AlertSettings.meaning.overdue_invoice': 'An invoice is still unpaid after its due date',
  'AlertSettings.meaning.project_over_budget': 'Spending goes over the project budget',
  'AlertSettings.meaning.stale_task': 'An open task has not changed',
  'AlertSettings.meaning.unusual_expense': 'An expense is far above the usual for its category',
  'AlertSettings.meaning.approval_waiting_on_client': 'A client has not answered an approval',
  'AlertSettings.meaning.approved_time_not_invoiced': 'Approved time waits to be invoiced',

  'AlertSettings.unit.days_before': 'days before',
  'AlertSettings.unit.percent_of_capacity': '% of capacity',
  'AlertSettings.unit.days_overdue': 'days overdue',
  'AlertSettings.unit.percent_of_budget': '% of budget',
  'AlertSettings.unit.days': 'days',
  'AlertSettings.unit.times_usual': '× the usual',

  'AlertSettings.recipient.project_lead': 'Project lead',
  'AlertSettings.recipient.their_manager': 'Their manager',
  'AlertSettings.recipient.assignee': 'Assignee',
  'AlertSettings.recipient.owner': 'Owner',
  'AlertSettings.recipient.project_lead_and_owner': 'Project lead and owner',
  'AlertSettings.recipient.finance_team': 'Finance team',
  'AlertSettings.recipient.owner_and_finance_team': 'Owner and finance team',
} as const;

export type AlertsCopyKey = keyof typeof ALERTS_COPY;

export const ruleKey = (rule: SignalRuleKey): AlertsCopyKey => `AlertSettings.rule.${rule}`;
export const meaningKey = (rule: SignalRuleKey): AlertsCopyKey => `AlertSettings.meaning.${rule}`;
export const unitKey = (unit: SignalThresholdUnit): AlertsCopyKey => `AlertSettings.unit.${unit}`;
export const recipientKey = (recipient: SignalRecipient): AlertsCopyKey =>
  `AlertSettings.recipient.${recipient}`;
