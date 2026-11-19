import { briefingReasonOf, formatMoney, money } from '@tmanage/domain';
import type {
  BriefingFigure,
  BriefingGroup,
  BriefingLine,
  BriefingReasonKey,
  SignalBriefingGroup,
  SignalSubjectType,
} from '@tmanage/domain';

/**
 * 62-A1c (B12) — the business briefing as one plain section of the digest mail: the Home card's
 * groups, counts, first lines and reasons for the same person (the domain builds both; the reason
 * sentence is picked by the domain's `briefingReasonOf`, the words are here). English, or Arabic
 * for an `ar*` locale, written from the meaning (the card's catalogue keys carry the same words).
 * A line names the record (task, invoice, person) as the card does; nothing else is quoted.
 */

export interface DigestBriefingGroup extends BriefingGroup {
  /** Absolute link of the group's full list (the card's "and N more"). */
  readonly link: string;
}

export interface DigestBriefingSection {
  readonly audience: 'company' | 'team';
  /** The last finished sweep. */
  readonly asOf: Date;
  /** The reader's zone, for the "as of" time. */
  readonly timezone: string;
  /** Never empty: an empty briefing is no section. */
  readonly groups: readonly DigestBriefingGroup[];
  /** Absolute link of Home, where the card is. */
  readonly homeLink: string;
}

type Language = 'en' | 'ar';

/** U+200F, the right-to-left mark: keeps a mixed Arabic/Latin line anchored right. */
const RLM = String.fromCodePoint(0x20_0f);

const GROUP: Readonly<Record<Language, Readonly<Record<SignalBriefingGroup, string>>>> = {
  en: {
    projects_at_risk: 'Projects at risk',
    money_to_collect: 'Money to collect',
    money_to_invoice: 'Money to invoice',
    people_overloaded: 'People overloaded',
    waiting_on_clients: 'Waiting on clients',
    over_budget: 'Over budget',
    stale_work: 'Stale work',
    unusual_expenses: 'Unusual expenses',
  },
  ar: {
    projects_at_risk: 'مشاريع في خطر',
    money_to_collect: 'مبالغ للتحصيل',
    money_to_invoice: 'مبالغ للفوترة',
    people_overloaded: 'أشخاص فوق طاقتهم',
    waiting_on_clients: 'بانتظار العملاء',
    over_budget: 'فوق الميزانية',
    stale_work: 'أعمال راكدة',
    unusual_expenses: 'مصروفات غير معتادة',
  },
};

const REASON: Readonly<Record<Language, Readonly<Record<BriefingReasonKey, string>>>> = {
  en: {
    dueLate: '{days} days past due, work still open',
    dueLateOne: 'One day past due, work still open',
    dueToday: 'Due today, the work left does not fit',
    dueTomorrow: 'Due tomorrow, the work left does not fit',
    dueIn: 'Due in {days} days, the work left does not fit',
    overloaded: '{percent}% of their capacity planned this week',
    overdue: '{days} days overdue',
    overdueAmount: '{amount}, {days} days overdue',
    overBudget: '{percent}% of the budget used',
    stale: 'No change for {days} days',
    unusualExpense: '{times}× the usual for this category',
    unusualExpenseAmount: '{amount}, {times}× the usual for this category',
    waitingOnClient: 'Waiting on the client for {days} days',
    notInvoiced: 'Approved time not invoiced for {days} days',
  },
  ar: {
    dueLate: 'تجاوز موعده بـ{days} أيام، والعمل ما زال مفتوحًا',
    dueLateOne: 'تجاوز موعده بيوم، والعمل ما زال مفتوحًا',
    dueToday: 'موعده اليوم، والعمل المتبقي لا يتّسع',
    dueTomorrow: 'موعده غدًا، والعمل المتبقي لا يتّسع',
    dueIn: 'موعده بعد {days} أيام، والعمل المتبقي لا يتّسع',
    overloaded: '{percent}٪ من طاقته مخطَّط لهذا الأسبوع',
    overdue: 'متأخرة {days} أيام',
    overdueAmount: '{amount}، متأخرة {days} أيام',
    overBudget: 'استُخدم {percent}٪ من الميزانية',
    stale: 'بلا تغيير منذ {days} أيام',
    unusualExpense: '{times} أضعاف المعتاد لهذه الفئة',
    unusualExpenseAmount: '{amount}، {times} أضعاف المعتاد لهذه الفئة',
    waitingOnClient: 'بانتظار العميل منذ {days} أيام',
    notInvoiced: 'وقت معتمد لم يُفوتر منذ {days} أيام',
  },
};

const UNTITLED: Readonly<Record<Language, Readonly<Record<SignalSubjectType, string>>>> = {
  en: {
    work_item: 'A task',
    membership: 'A person',
    client_invoice: 'An invoice',
    project: 'A project',
    expense: 'An expense',
    approval: 'An approval',
  },
  ar: {
    work_item: 'مهمة',
    membership: 'شخص',
    client_invoice: 'فاتورة',
    project: 'مشروع',
    expense: 'مصروف',
    approval: 'موافقة',
  },
};

const WORDS: Readonly<
  Record<
    Language,
    {
      readonly title: string;
      readonly asOf: string;
      readonly company: string;
      readonly team: string;
      readonly more: string;
      readonly open: string;
    }
  >
> = {
  en: {
    title: 'Business briefing',
    asOf: 'As of {time}',
    company: 'What needs you across the company. We check every hour.',
    team: 'What needs you on your projects. We check every hour.',
    more: 'and {count} more: {link}',
    open: 'Open the briefing on Home: {link}',
  },
  ar: {
    title: 'موجز العمل',
    asOf: 'حتى {time}',
    company: 'ما يحتاجك في الشركة كلها. نتحقق كل ساعة.',
    team: 'ما يحتاجك في مشاريعك. نتحقق كل ساعة.',
    more: 'و{count} أخرى: {link}',
    open: 'افتح الموجز في الرئيسية: {link}',
  },
};

function fill(template: string, values: Readonly<Record<string, string>>): string {
  return template.replace(/\{(\w+)\}/gu, (hole, name: string) => values[name] ?? hole);
}

function oneLine(value: string): string {
  return value.replaceAll(/\s+/gu, ' ').trim();
}

function amountText(minor: number, currency: string, language: Language): string {
  try {
    return formatMoney(money(minor, currency), language === 'ar' ? 'ar' : 'en');
  } catch {
    return `${String(minor)} ${currency}`;
  }
}

function timeText(at: Date, timezone: string, language: Language): string {
  const options: Intl.DateTimeFormatOptions = {
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    numberingSystem: 'latn',
  };
  const locale = language === 'ar' ? 'ar' : 'en';
  try {
    return new Intl.DateTimeFormat(locale, { ...options, timeZone: timezone }).format(at);
  } catch {
    return new Intl.DateTimeFormat(locale, { ...options, timeZone: 'UTC' }).format(at);
  }
}

/** A line's reason in words, from the figures the sweep stored. */
export function briefingReasonText(line: BriefingLine, language: Language): string {
  const reason = briefingReasonOf(line);
  const values: Record<string, string> = {};
  for (const [name, figure] of Object.entries(reason.figures) as [BriefingFigure, number][]) {
    values[name] = String(figure);
  }
  if (reason.amount !== null) {
    values['amount'] = amountText(reason.amount.minor, reason.amount.currency, language);
  }
  return fill(REASON[language][reason.key], values);
}

/** "Launch kit · Cedar Foods brand refresh: 2 days past due, work still open". */
export function briefingLineText(line: BriefingLine, language: Language): string {
  const name = oneLine(line.title ?? UNTITLED[language][line.subjectType]);
  const where = line.context === null ? '' : ` · ${oneLine(line.context)}`;
  return `${name}${where}: ${briefingReasonText(line, language)}`;
}

/** The section's paragraphs, in the mail's language; joined by the mail like its other parts. */
export function briefingSectionParagraphs(
  section: DigestBriefingSection,
  language: Language,
): readonly string[] {
  const words = WORDS[language];
  const mark = language === 'ar' ? RLM : '';
  const heading = `${mark}${words.title} — ${fill(words.asOf, {
    time: timeText(section.asOf, section.timezone, language),
  })}`;
  const lead = `${mark}${section.audience === 'company' ? words.company : words.team}`;
  const groups = section.groups.map((group) =>
    [
      `${mark}${GROUP[language][group.group]} (${String(group.count)})`,
      ...group.lines.map((line) => `${mark}• ${briefingLineText(line, language)}`),
      ...(group.more > 0
        ? [`${mark}  ${fill(words.more, { count: String(group.more), link: group.link })}`]
        : []),
    ].join('\n'),
  );
  return [heading, lead, ...groups, `${mark}${fill(words.open, { link: section.homeLink })}`];
}
