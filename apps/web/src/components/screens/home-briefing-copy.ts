import { briefingReasonOf } from '@tmanage/domain';
import type { BriefingReason } from '@tmanage/domain';
import type { BriefingGroupKey, BriefingLine } from '../../lib/api/home-briefing';

/**
 * 62-A1b (B11) — every word the Home business briefing card draws, in one place, including the
 * words for each reason the domain picks from the stored figures ("No change for 16 days").
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

  'HomeBriefing.group.projects_at_risk': 'Late or at-risk tasks',
  'HomeBriefing.group.money_to_collect': 'Money to collect',
  'HomeBriefing.group.money_to_invoice': 'Money to invoice',
  'HomeBriefing.group.people_overloaded': 'People overloaded',
  'HomeBriefing.group.waiting_on_clients': 'Waiting on clients',
  'HomeBriefing.group.over_budget': 'Over budget',
  'HomeBriefing.group.stale_work': 'Stale work',
  'HomeBriefing.group.unusual_expenses': 'Unusual expenses',

  // A counted reason keeps one key per CLDR plural form in the catalogs (`.zero` … `.other`,
  // Arabic uses all six); the English here is the `.one` / `.other` pair (see `reasonKey`).
  'HomeBriefing.reason.dueLate.one': 'One day past due, work still open',
  'HomeBriefing.reason.dueLate.other': '{days} days past due, work still open',
  'HomeBriefing.reason.dueToday': 'Due today, work still open',
  'HomeBriefing.reason.dueTomorrow': 'Due tomorrow, the work left does not fit',
  'HomeBriefing.reason.dueIn.one': 'Due in one day, the work left does not fit',
  'HomeBriefing.reason.dueIn.other': 'Due in {days} days, the work left does not fit',
  'HomeBriefing.reason.overloaded': '{percent}% of their capacity planned this week',
  'HomeBriefing.reason.overdue.one': 'One day overdue',
  'HomeBriefing.reason.overdue.other': '{days} days overdue',
  'HomeBriefing.reason.overdueAmount.one': '{amount}, one day overdue',
  'HomeBriefing.reason.overdueAmount.other': '{amount}, {days} days overdue',
  'HomeBriefing.reason.overBudget': '{percent}% of the budget used',
  'HomeBriefing.reason.stale.one': 'No change for one day',
  'HomeBriefing.reason.stale.other': 'No change for {days} days',
  'HomeBriefing.reason.unusualExpense.one': '{times}× the usual for this category',
  'HomeBriefing.reason.unusualExpense.other': '{times}× the usual for this category',
  'HomeBriefing.reason.unusualExpenseAmount.one': '{amount}, {times}× the usual for this category',
  'HomeBriefing.reason.unusualExpenseAmount.other':
    '{amount}, {times}× the usual for this category',
  'HomeBriefing.reason.waitingOnClient.one': 'Waiting on the client for one day',
  'HomeBriefing.reason.waitingOnClient.other': 'Waiting on the client for {days} days',
  'HomeBriefing.reason.notInvoiced.one': 'Approved time not invoiced for one day',
  'HomeBriefing.reason.notInvoiced.other': 'Approved time not invoiced for {days} days',

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
  /** The catalog word for a key; `english` until the key reaches the catalogs. */
  readonly text: (key: string, english: string) => string;
  /** The reader's plural form of a count (`Intl.PluralRules` of the active locale). */
  readonly plural: (count: number) => Intl.LDMLPluralRule;
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

/**
 * The catalog key of a reason and its English: a counted reason (`count` set) in the reader's
 * plural form — «يومين», «3 أيام», «11 يومًا» (T4 F5) — the English taking `.one` or `.other`.
 */
export function reasonKey(
  reason: BriefingReason,
  plural: ReasonFormat['plural'],
): { readonly key: string; readonly english: string } {
  const base = `HomeBriefing.reason.${reason.key}`;
  if (reason.count === null) return { key: base, english: copyOf(base) };
  const category = plural(reason.count);
  return {
    key: `${base}.${category}`,
    english: copyOf(`${base}.${category === 'one' ? 'one' : 'other'}`),
  };
}

function copyOf(key: string): string {
  return (BRIEFING_COPY as Readonly<Record<string, string>>)[key] ?? key;
}

/** A line's reason in words, from the figures the sweep stored (domain `briefingReasonOf`). */
export function briefingReason(line: BriefingLine, format: ReasonFormat): FilledText {
  const reason = briefingReasonOf(line);
  const values: Record<string, string> = {};
  for (const [name, figure] of Object.entries(reason.figures)) values[name] = format.number(figure);
  if (reason.amount !== null) {
    values['amount'] = format.money(reason.amount.minor, reason.amount.currency);
  }
  const { key, english } = reasonKey(reason, format.plural);
  return { template: format.text(key, english), values };
}

/** A line's name: its record's title, else a plain word for its kind. */
export function briefingTitle(line: BriefingLine, text: (key: BriefingCopyKey) => string): string {
  return line.title ?? text(`HomeBriefing.untitled.${line.subjectType}`);
}
