import type { BriefingGroupKey, BriefingLine } from '../../lib/api/home-briefing';

/**
 * 62-A1b (B11) — every word the Home business briefing card draws, in one place, and the one
 * function that says a line's reason from its stored figures ("No change for 16 days").
 *
 * The keys reach `en.json` / `ar.json` through the wiring step (B11-REPORT, WIRING); until then
 * `tOr` returns the English given here, never a raw key. `{name}` holes are filled after the
 * translation, so a language may move a value to wherever its grammar puts it. Per cent has no
 * space before the sign (FIGMA-D fix 21).
 */
export const BRIEFING_COPY = {
  'HomeBriefing.title': 'Business briefing',
  'HomeBriefing.asOfToday': 'As of {time} today',
  'HomeBriefing.asOf': 'As of {time}',
  'HomeBriefing.leadCompany': 'What needs you across the company. We check every hour.',
  'HomeBriefing.leadTeam': 'What needs you on your projects. We check every hour.',
  'HomeBriefing.hide': 'Hide from Home',
  'HomeBriefing.hidden': 'Business briefing hidden from Home',
  'HomeBriefing.emptyTitle': 'Nothing needs you today',
  'HomeBriefing.emptyBody': 'We check your company’s work every hour. Last check at {time}.',
  'HomeBriefing.emptyNotYet':
    'We check your company’s work every hour. The first check is on its way.',
  'HomeBriefing.loadFailed': 'Could not load the briefing. Try again.',
  'HomeBriefing.tryAgain': 'Try again',
  'HomeBriefing.more': 'and {count} more',
  'HomeBriefing.countLabel': '{count} in {group}',

  'HomeBriefing.group.projects_at_risk': 'Projects at risk',
  'HomeBriefing.group.money_to_collect': 'Money to collect',
  'HomeBriefing.group.money_to_invoice': 'Money to invoice',
  'HomeBriefing.group.people_overloaded': 'People overloaded',
  'HomeBriefing.group.waiting_on_clients': 'Waiting on clients',
  'HomeBriefing.group.over_budget': 'Over budget',
  'HomeBriefing.group.stale_work': 'Stale work',
  'HomeBriefing.group.unusual_expenses': 'Unusual expenses',

  'HomeBriefing.reason.dueLate': '{days} days past due, work still open',
  'HomeBriefing.reason.dueLateOne': 'One day past due, work still open',
  'HomeBriefing.reason.dueToday': 'Due today, the work left does not fit',
  'HomeBriefing.reason.dueTomorrow': 'Due tomorrow, the work left does not fit',
  'HomeBriefing.reason.dueIn': 'Due in {days} days, the work left does not fit',
  'HomeBriefing.reason.overloaded': '{percent}% of their capacity planned this week',
  'HomeBriefing.reason.overdue': '{days} days overdue',
  'HomeBriefing.reason.overdueAmount': '{amount}, {days} days overdue',
  'HomeBriefing.reason.overBudget': '{percent}% of the budget used',
  'HomeBriefing.reason.stale': 'No change for {days} days',
  'HomeBriefing.reason.unusualExpense': '{times}× the usual for this category',
  'HomeBriefing.reason.unusualExpenseAmount': '{amount}, {times}× the usual for this category',
  'HomeBriefing.reason.waitingOnClient': 'Waiting on the client for {days} days',
  'HomeBriefing.reason.notInvoiced': 'Approved time not invoiced for {days} days',

  'HomeBriefing.untitled.work_item': 'A task',
  'HomeBriefing.untitled.membership': 'A person',
  'HomeBriefing.untitled.client_invoice': 'An invoice',
  'HomeBriefing.untitled.project': 'A project',
  'HomeBriefing.untitled.expense': 'An expense',
  'HomeBriefing.untitled.approval': 'An approval',
} as const;

export type BriefingCopyKey = keyof typeof BRIEFING_COPY;

export function groupKey(group: BriefingGroupKey): BriefingCopyKey {
  return `HomeBriefing.group.${group}`;
}

export function fillHoles(template: string, values: Readonly<Record<string, string>>): string {
  return template.replace(/\{(\w+)\}/g, (hole, name: string) => values[name] ?? hole);
}

/** What the reason needs to say a figure in the reader's locale. */
export interface ReasonFormat {
  readonly text: (key: BriefingCopyKey) => string;
  readonly number: (value: number) => string;
  readonly money: (minor: number, currency: string) => string;
}

/** A sentence with holes, and the values that fill them (each drawn isolated, FIGMA-D fix 20). */
export interface FilledText {
  readonly template: string;
  readonly values: Readonly<Record<string, string>>;
}

/** The parts of a filled sentence in order: words, and the values that go in the holes. */
export function filledParts(
  text: FilledText,
): readonly { readonly kind: 'text' | 'value'; readonly value: string }[] {
  return text.template
    .split(/(\{\w+\})/)
    .filter((part) => part !== '')
    .map((part) => {
      const name = /^\{(\w+)\}$/.exec(part)?.[1];
      const value = name === undefined ? undefined : text.values[name];
      return value === undefined
        ? { kind: 'text' as const, value: part }
        : { kind: 'value' as const, value };
    });
}

/** A line's reason in words, from the figures the sweep stored. Never content. */
export function briefingReason(line: BriefingLine, format: ReasonFormat): FilledText {
  const say = (
    key: BriefingCopyKey,
    values: Readonly<Record<string, string>> = {},
  ): FilledText => ({
    template: format.text(key),
    values,
  });
  const days = format.number(Math.abs(line.measure));
  const amount =
    line.amount === null ? null : format.money(line.amount.minor, line.amount.currency);
  switch (line.rule) {
    case 'deadline_at_risk':
      if (line.measure < -1) return say('HomeBriefing.reason.dueLate', { days });
      if (line.measure === -1) return say('HomeBriefing.reason.dueLateOne');
      if (line.measure === 0) return say('HomeBriefing.reason.dueToday');
      if (line.measure === 1) return say('HomeBriefing.reason.dueTomorrow');
      return say('HomeBriefing.reason.dueIn', { days });
    case 'overloaded_person':
      return say('HomeBriefing.reason.overloaded', { percent: format.number(line.measure) });
    case 'overdue_invoice':
      return amount === null
        ? say('HomeBriefing.reason.overdue', { days })
        : say('HomeBriefing.reason.overdueAmount', { amount, days });
    case 'project_over_budget':
      return say('HomeBriefing.reason.overBudget', { percent: format.number(line.measure) });
    case 'stale_task':
      return say('HomeBriefing.reason.stale', { days });
    case 'unusual_expense': {
      const times = format.number(line.measure);
      return amount === null
        ? say('HomeBriefing.reason.unusualExpense', { times })
        : say('HomeBriefing.reason.unusualExpenseAmount', { amount, times });
    }
    case 'approval_waiting_on_client':
      return say('HomeBriefing.reason.waitingOnClient', { days });
    case 'approved_time_not_invoiced':
      return say('HomeBriefing.reason.notInvoiced', { days });
  }
}

/** A line's name: its record's title, else a plain word for its kind. */
export function briefingTitle(line: BriefingLine, text: (key: BriefingCopyKey) => string): string {
  return line.title ?? text(`HomeBriefing.untitled.${line.subjectType}`);
}
