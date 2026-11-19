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
    projects_at_risk: 'Late or at-risk tasks',
    money_to_collect: 'Money to collect',
    money_to_invoice: 'Money to invoice',
    people_overloaded: 'People overloaded',
    waiting_on_clients: 'Waiting on clients',
    over_budget: 'Over budget',
    stale_work: 'Stale work',
    unusual_expenses: 'Unusual expenses',
  },
  ar: {
    projects_at_risk: 'مهام متأخرة أو معرّضة للتأخير',
    money_to_collect: 'مبالغ للتحصيل',
    money_to_invoice: 'مبالغ للفوترة',
    people_overloaded: 'أشخاص فوق طاقتهم',
    waiting_on_clients: 'بانتظار العملاء',
    over_budget: 'فوق الميزانية',
    stale_work: 'أعمال راكدة',
    unusual_expenses: 'مصروفات غير معتادة',
  },
};

/**
 * A reason's words in each plural form the language has (CLDR: English one/other, Arabic all six);
 * an uncounted reason has `other` only. `{days}` / `{times}` / `{amount}` holes are filled after.
 */
type ReasonWords = Readonly<Partial<Record<Intl.LDMLPluralRule, string>>> & {
  readonly other: string;
};

const REASON: Readonly<Record<Language, Readonly<Record<BriefingReasonKey, ReasonWords>>>> = {
  en: {
    dueLate: {
      one: 'One day past due, work still open',
      other: '{days} days past due, work still open',
    },
    dueToday: { other: 'Due today, work still open' },
    dueTomorrow: { other: 'Due tomorrow, the work left does not fit' },
    dueIn: {
      one: 'Due in one day, the work left does not fit',
      other: 'Due in {days} days, the work left does not fit',
    },
    overloaded: { other: '{percent}% of their capacity planned this week' },
    overdue: { one: 'One day overdue', other: '{days} days overdue' },
    overdueAmount: { one: '{amount}, one day overdue', other: '{amount}, {days} days overdue' },
    overBudget: { other: '{percent}% of the budget used' },
    stale: { one: 'No change for one day', other: 'No change for {days} days' },
    unusualExpense: { other: '{times}× the usual for this category' },
    unusualExpenseAmount: { other: '{amount}, {times}× the usual for this category' },
    waitingOnClient: {
      one: 'Waiting on the client for one day',
      other: 'Waiting on the client for {days} days',
    },
    notInvoiced: {
      one: 'Approved time not invoiced for one day',
      other: 'Approved time not invoiced for {days} days',
    },
  },
  ar: {
    dueLate: {
      zero: 'تجاوز موعده، والعمل ما زال مفتوحًا',
      one: 'تجاوز موعده بيوم، والعمل ما زال مفتوحًا',
      two: 'تجاوز موعده بيومين، والعمل ما زال مفتوحًا',
      few: 'تجاوز موعده بـ{days} أيام، والعمل ما زال مفتوحًا',
      many: 'تجاوز موعده بـ{days} يومًا، والعمل ما زال مفتوحًا',
      other: 'تجاوز موعده بـ{days} يوم، والعمل ما زال مفتوحًا',
    },
    dueToday: { other: 'موعده اليوم، والعمل ما زال مفتوحًا' },
    dueTomorrow: { other: 'موعده غدًا، والعمل المتبقي لا يتّسع' },
    dueIn: {
      zero: 'موعده اليوم، والعمل المتبقي لا يتّسع',
      one: 'موعده بعد يوم، والعمل المتبقي لا يتّسع',
      two: 'موعده بعد يومين، والعمل المتبقي لا يتّسع',
      few: 'موعده بعد {days} أيام، والعمل المتبقي لا يتّسع',
      many: 'موعده بعد {days} يومًا، والعمل المتبقي لا يتّسع',
      other: 'موعده بعد {days} يوم، والعمل المتبقي لا يتّسع',
    },
    overloaded: { other: '{percent}٪ من طاقته مخطَّط لهذا الأسبوع' },
    overdue: {
      zero: 'مستحقة اليوم',
      one: 'متأخرة يومًا واحدًا',
      two: 'متأخرة يومين',
      few: 'متأخرة {days} أيام',
      many: 'متأخرة {days} يومًا',
      other: 'متأخرة {days} يوم',
    },
    overdueAmount: {
      zero: '{amount}، مستحقة اليوم',
      one: '{amount}، متأخرة يومًا واحدًا',
      two: '{amount}، متأخرة يومين',
      few: '{amount}، متأخرة {days} أيام',
      many: '{amount}، متأخرة {days} يومًا',
      other: '{amount}، متأخرة {days} يوم',
    },
    overBudget: { other: 'استُخدم {percent}٪ من الميزانية' },
    stale: {
      zero: 'تغيّرت اليوم',
      one: 'بلا تغيير منذ يوم',
      two: 'بلا تغيير منذ يومين',
      few: 'بلا تغيير منذ {days} أيام',
      many: 'بلا تغيير منذ {days} يومًا',
      other: 'بلا تغيير منذ {days} يوم',
    },
    unusualExpense: {
      zero: 'أقل من المعتاد لهذه الفئة',
      one: 'بقدر المعتاد لهذه الفئة',
      two: 'ضعف المعتاد لهذه الفئة',
      few: '{times} أضعاف المعتاد لهذه الفئة',
      many: '{times} ضعفًا من المعتاد لهذه الفئة',
      other: '{times} ضعف المعتاد لهذه الفئة',
    },
    unusualExpenseAmount: {
      zero: '{amount}، أقل من المعتاد لهذه الفئة',
      one: '{amount}، بقدر المعتاد لهذه الفئة',
      two: '{amount}، ضعف المعتاد لهذه الفئة',
      few: '{amount}، {times} أضعاف المعتاد لهذه الفئة',
      many: '{amount}، {times} ضعفًا من المعتاد لهذه الفئة',
      other: '{amount}، {times} ضعف المعتاد لهذه الفئة',
    },
    waitingOnClient: {
      zero: 'بانتظار العميل منذ اليوم',
      one: 'بانتظار العميل منذ يوم',
      two: 'بانتظار العميل منذ يومين',
      few: 'بانتظار العميل منذ {days} أيام',
      many: 'بانتظار العميل منذ {days} يومًا',
      other: 'بانتظار العميل منذ {days} يوم',
    },
    notInvoiced: {
      zero: 'وقت معتمد اليوم لم يُفوتر بعد',
      one: 'وقت معتمد لم يُفوتر منذ يوم',
      two: 'وقت معتمد لم يُفوتر منذ يومين',
      few: 'وقت معتمد لم يُفوتر منذ {days} أيام',
      many: 'وقت معتمد لم يُفوتر منذ {days} يومًا',
      other: 'وقت معتمد لم يُفوتر منذ {days} يوم',
    },
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
  const words = REASON[language][reason.key];
  const form =
    reason.count === null ? 'other' : new Intl.PluralRules(language).select(reason.count);
  return fill(words[form] ?? words.other, values);
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
