/**
 * 55-25 — the quick-add word tables, English and Arabic.
 *
 * Every entry is a regular-expression *source* without boundaries; `parse.ts` wraps it. Arabic
 * words go through {@link arabicWord}, so «غدًا», «غداً» and «غدا» are one word, «الاسبوع» is
 * «الأسبوع», «بكره» is «بكرة» and a tatweel («لـسارة») never breaks a match.
 */

export type RelativeDate =
  'today' | 'tomorrow' | 'after_tomorrow' | 'next_week' | 'end_of_week' | 'end_of_month';

export type QuickAddPriority = 'p1' | 'p2' | 'p3';

export interface WordEntry<V> {
  readonly pattern: string;
  readonly value: V;
}

/** Tashkeel, superscript alef and tatweel: allowed after any Arabic letter. */
const MARKS = '[\\u064B-\\u065F\\u0670\\u0640]*';

const LETTER_CLASS: Readonly<Record<string, string>> = {
  ا: '[اأإآ]',
  أ: '[اأإآ]',
  إ: '[اأإآ]',
  آ: '[اأإآ]',
  ة: '[ةه]',
  ه: '[هة]',
  ى: '[ىي]',
  ي: '[يى]',
};

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
}

/** An Arabic word or phrase as a pattern: hamza/ta-marbuta/alef-maqsura tolerant, marks allowed. */
export function arabicWord(word: string): string {
  let out = '';
  for (const char of word) {
    if (char === ' ') {
      out += '\\s+';
      continue;
    }
    const isArabic = /[\u0600-\u06FF]/u.test(char);
    out += (LETTER_CLASS[char] ?? escapeRegExp(char)) + (isArabic ? MARKS : '');
  }
  return out;
}

/** Arabic words as one alternation. */
export function arabicAny(words: readonly string[]): string {
  return words.map(arabicWord).join('|');
}

/** Characters that end a word (whitespace, punctuation, quotes, bidi marks). */
export const WORD_EDGE = '[\\s,،.;:!?()\\[\\]{}«»"\'\\u200E\\u200F\\u061C\\u2066-\\u2069]';

/** "by Friday", «حتى الخميس», «في الأسبوع القادم» — consumed with the date that follows. */
export const DATE_PREFIX = `(?:(?:(?:due\\s+)?(?:by|on|before|until|till)|due|${arabicAny([
  'في',
  'حتى',
  'قبل',
  'بحلول',
  'موعد',
])})\\s+)?`;

export const RELATIVE_DATE_WORDS: readonly WordEntry<RelativeDate>[] = [
  { pattern: 'today|tdy', value: 'today' },
  { pattern: 'tomorrow|tmrw?|tomorow', value: 'tomorrow' },
  { pattern: '(?:the\\s+)?day\\s+after\\s+tomorrow|overmorrow', value: 'after_tomorrow' },
  { pattern: '(?:the\\s+)?next\\s+week', value: 'next_week' },
  { pattern: '(?:the\\s+)?end\\s+of\\s+(?:the\\s+|this\\s+)?week|eow', value: 'end_of_week' },
  {
    pattern: '(?:the\\s+)?end\\s+of\\s+(?:the\\s+|this\\s+)?month|eom|month[\\s-]end',
    value: 'end_of_month',
  },
  { pattern: arabicAny(['اليوم', 'النهارده', 'النهاردة']), value: 'today' },
  { pattern: arabicAny(['غدا', 'غد', 'بكرة', 'باكر', 'بكرا']), value: 'tomorrow' },
  { pattern: arabicAny(['بعد غد', 'بعد غدا', 'بعد بكرة', 'بعد بكرا']), value: 'after_tomorrow' },
  {
    pattern: arabicAny([
      'الأسبوع القادم',
      'الأسبوع المقبل',
      'الأسبوع الجاي',
      'الأسبوع اللي جاي',
      'الأسبوع الجاية',
    ]),
    value: 'next_week',
  },
  { pattern: arabicAny(['نهاية الأسبوع', 'آخر الأسبوع', 'اخر الاسبوع']), value: 'end_of_week' },
  { pattern: arabicAny(['نهاية الشهر', 'آخر الشهر', 'أواخر الشهر']), value: 'end_of_month' },
];

/** Weekday names, 0 = Sunday. English full names and the usual abbreviations. */
export const WEEKDAY_WORDS: readonly WordEntry<number>[] = [
  { pattern: `sunday|sun|${arabicAny(['الأحد', 'الحد'])}`, value: 0 },
  { pattern: `monday|mon|${arabicAny(['الاثنين', 'الإثنين', 'الاتنين', 'الأثنين'])}`, value: 1 },
  {
    pattern: `tuesday|tues|tue|${arabicAny(['الثلاثاء', 'الثلاثا', 'التلات', 'التلاتاء'])}`,
    value: 2,
  },
  { pattern: `wednesday|wed|${arabicAny(['الأربعاء', 'الأربع', 'الاربعا'])}`, value: 3 },
  { pattern: `thursday|thurs|thur|thu|${arabicAny(['الخميس'])}`, value: 4 },
  { pattern: `friday|fri|${arabicAny(['الجمعة'])}`, value: 5 },
  { pattern: `saturday|sat|${arabicAny(['السبت'])}`, value: 6 },
];

/** "next Thursday" / «الخميس القادم»: the same day as a bare weekday (never today). */
export const WEEKDAY_BEFORE = `(?:(?:next|this|coming)\\s+)?`;
export const WEEKDAY_DAY_WORD = `(?:${arabicWord('يوم')}\\s+)?`;
export const WEEKDAY_AFTER = `(?:\\s+(?:${arabicAny(['القادم', 'القادمة', 'المقبل', 'الجاي', 'الجاية', 'دا', 'ده'])}))?`;

/** Month names, 1 = January: English, Egyptian/Gulf Arabic and Levantine Arabic. */
export const MONTH_WORDS: readonly WordEntry<number>[] = [
  { pattern: `january|jan|${arabicAny(['يناير', 'كانون الثاني'])}`, value: 1 },
  { pattern: `february|feb|${arabicAny(['فبراير', 'شباط'])}`, value: 2 },
  { pattern: `march|mar|${arabicAny(['مارس', 'آذار'])}`, value: 3 },
  { pattern: `april|apr|${arabicAny(['أبريل', 'إبريل', 'نيسان'])}`, value: 4 },
  { pattern: `may|${arabicAny(['مايو', 'أيار'])}`, value: 5 },
  { pattern: `june|jun|${arabicAny(['يونيو', 'يونيه', 'حزيران'])}`, value: 6 },
  { pattern: `july|jul|${arabicAny(['يوليو', 'يوليه', 'تموز'])}`, value: 7 },
  { pattern: `august|aug|${arabicAny(['أغسطس', 'آب'])}`, value: 8 },
  { pattern: `september|sept|sep|${arabicAny(['سبتمبر', 'أيلول'])}`, value: 9 },
  { pattern: `october|oct|${arabicAny(['أكتوبر', 'تشرين الأول'])}`, value: 10 },
  { pattern: `november|nov|${arabicAny(['نوفمبر', 'تشرين الثاني'])}`, value: 11 },
  { pattern: `december|dec|${arabicAny(['ديسمبر', 'كانون الأول'])}`, value: 12 },
];

/** Small counts written as words (days, weeks, hours). */
export const NUMBER_WORDS: readonly WordEntry<number>[] = [
  { pattern: `one|an?|${arabicAny(['واحد', 'واحدة'])}`, value: 1 },
  { pattern: `two|${arabicAny(['اثنين', 'اثنان', 'اتنين'])}`, value: 2 },
  { pattern: `three|${arabicAny(['ثلاث', 'ثلاثة', 'تلات', 'تلاتة'])}`, value: 3 },
  { pattern: `four|${arabicAny(['أربع', 'أربعة'])}`, value: 4 },
  { pattern: `five|${arabicAny(['خمس', 'خمسة'])}`, value: 5 },
  { pattern: `six|${arabicAny(['ست', 'ستة'])}`, value: 6 },
  { pattern: `seven|${arabicAny(['سبع', 'سبعة'])}`, value: 7 },
  { pattern: `eight|${arabicAny(['ثمان', 'ثماني', 'ثمانية', 'تمن', 'تمانية'])}`, value: 8 },
  { pattern: `nine|${arabicAny(['تسع', 'تسعة'])}`, value: 9 },
  { pattern: `ten|${arabicAny(['عشر', 'عشرة'])}`, value: 10 },
];

export const PRIORITY_WORDS: readonly WordEntry<QuickAddPriority>[] = [
  {
    pattern: `p1|!1|urgent|asap|high\\s+priority|${arabicAny(['عاجل', 'عاجلة', 'مستعجل', 'مستعجلة', 'أولوية عالية', 'ضروري'])}`,
    value: 'p1',
  },
  {
    pattern: `p2|!2|important|medium\\s+priority|${arabicAny(['مهم', 'هام', 'أولوية متوسطة'])}`,
    value: 'p2',
  },
  {
    pattern: `p3|!3|low\\s+priority|${arabicAny(['أولوية منخفضة', 'غير عاجل', 'مش مستعجل'])}`,
    value: 'p3',
  },
];

/** Fixed Arabic durations, in minutes. Longest phrases first. */
export const ARABIC_DURATIONS: readonly WordEntry<number>[] = [
  { pattern: arabicAny(['ساعتين ونصف', 'ساعتين ونص']), value: 150 },
  { pattern: arabicAny(['ساعة ونصف', 'ساعة ونص']), value: 90 },
  { pattern: arabicAny(['ساعة وربع']), value: 75 },
  { pattern: arabicAny(['ساعتين', 'ساعتان']), value: 120 },
  { pattern: arabicAny(['نصف ساعة', 'نص ساعة']), value: 30 },
  { pattern: arabicAny(['ربع ساعة']), value: 15 },
  { pattern: arabicAny(['ساعة']), value: 60 },
  { pattern: arabicAny(['دقيقتين']), value: 2 },
];

/** Fixed English durations, in minutes. */
export const ENGLISH_DURATIONS: readonly WordEntry<number>[] = [
  { pattern: '(?:an?|one)\\s+hour\\s+and\\s+a\\s+half', value: 90 },
  { pattern: 'half\\s+(?:an\\s+)?hour', value: 30 },
  { pattern: '(?:a\\s+)?quarter\\s+(?:of\\s+)?(?:an\\s+)?hour', value: 15 },
  { pattern: '(?:an?|one)\\s+hour', value: 60 },
];

export const ARABIC_HOURS = arabicAny(['ساعات', 'ساعة']);
export const ARABIC_MINUTES = arabicAny(['دقيقة', 'دقائق', 'دقايق']);
export const ESTIMATE_PREFIX = `(?:(?:for|est\\.?|estimate|~)\\s*|(?:${arabicAny(['لمدة', 'مدة', 'مدته'])})\\s+)?`;

/** Units after «بعد»/«خلال» and "in": the count's unit, and whether it is a dual («يومين»). */
export const ARABIC_DAY_UNITS = arabicAny(['أيام', 'ايام', 'يوم']);
export const ARABIC_DAY_DUAL = arabicAny(['يومين', 'يومان']);
export const ARABIC_WEEK_UNITS = arabicAny(['أسابيع', 'أسبوع']);
export const ARABIC_WEEK_DUAL = arabicAny(['أسبوعين', 'أسبوعان']);
export const ARABIC_WORKING = arabicAny(['عمل']);
export const ARABIC_IN = arabicAny(['بعد', 'خلال']);

/** Owner and project markers. */
export const ARABIC_PROJECT_MARKER = `(?:(?:${arabicAny(['في', 'على', 'ضمن'])})\\s+|${arabicWord('ل')})${arabicWord('مشروع')}\\s+`;
export const ENGLISH_PROJECT_MARKER = '(?:in|on|for|under)\\s+(?:the\\s+)?project\\s+';
