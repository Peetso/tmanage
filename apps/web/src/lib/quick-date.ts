/**
 * Quick add's natural-language due date (FIX-QUEUE B1): "Call Sara tomorrow 3pm" files "Call
 * Sara", due tomorrow at 15:00 local time. Pure and small on purpose: one day phrase (today,
 * tonight, tomorrow, the day after tomorrow, a weekday name) and one time phrase ("3pm",
 * "3:30 pm", "15:00"), in English and Arabic. The matched words leave the title; when nothing
 * would be left of the title, nothing is parsed and the title is kept as typed.
 */

export interface QuickDate {
  /** The title with the date words removed. */
  readonly title: string;
  /** The due day, `YYYY-MM-DD` in local time. */
  readonly day: string;
  /** The due time, when one was written. */
  readonly time: { readonly hour: number; readonly minute: number } | null;
}

// Not a letter or digit on either side: `\b` does not see Arabic letters.
const L = '(?<![\\p{L}\\p{N}])';
const R = '(?![\\p{L}\\p{N}])';

const WEEKDAYS: readonly (readonly string[])[] = [
  ['sunday', 'الأحد', 'الاحد'],
  ['monday', 'الاثنين', 'الإثنين'],
  ['tuesday', 'الثلاثاء'],
  ['wednesday', 'الأربعاء', 'الاربعاء'],
  ['thursday', 'الخميس'],
  ['friday', 'الجمعة'],
  ['saturday', 'السبت'],
];

const RELATIVE: readonly (readonly [number, readonly string[]])[] = [
  [2, ['day after tomorrow', 'بعد غدٍ', 'بعد غداً', 'بعد غد', 'بعد بكرة']],
  [1, ['tomorrow', 'غداً', 'غدًا', 'غدا', 'غد', 'بكرة', 'بكره']],
  [0, ['today', 'tonight', 'اليوم', 'الليلة']],
];

const escape = (word: string): string => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const alt = (words: readonly string[]): string => words.map(escape).join('|');

const DAY_LEAD = '(?:(?:due|by|on|next|this|يوم|في)\\s+)?';
const TIME_LEAD = '(?:(?:at|@|الساعة|الساعه|في)\\s*)?';
const PM = 'pm|p\\.m\\.|مساءً|مساءا|مساء|م';
const AM = 'am|a\\.m\\.|صباحاً|صباحا|صباح|ص';

const TIME_12 = new RegExp(
  `${L}${TIME_LEAD}(\\d{1,2})(?::(\\d{2}))?\\s*(${PM}|${AM})(?![\\p{L}\\p{N}.])`,
  'iu',
);
const TIME_24 = new RegExp(`${L}${TIME_LEAD}([01]?\\d|2[0-3]):([0-5]\\d)${R}`, 'iu');

/** Arabic-Indic digits to ASCII, one character for one, so match offsets stay valid. */
function asciiDigits(text: string): string {
  return text.replace(/[٠-٩۰-۹]/g, (digit) => String((digit.charCodeAt(0) & 0xf) % 10));
}

function localDay(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

function addDays(now: Date, days: number): Date {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() + days);
}

interface Hit {
  readonly index: number;
  readonly length: number;
}

function findDay(text: string, now: Date): (Hit & { readonly offset: number }) | null {
  for (const [offset, words] of RELATIVE) {
    const match = new RegExp(`${L}${DAY_LEAD}(?:${alt(words)})${R}`, 'iu').exec(text);
    if (match) return { index: match.index, length: match[0].length, offset };
  }
  for (const [weekday, words] of WEEKDAYS.entries()) {
    const match = new RegExp(`${L}${DAY_LEAD}(?:${alt(words ?? [])})${R}`, 'iu').exec(text);
    // The next such weekday, never today: "Friday" said on a Friday means next week.
    if (match) {
      const offset = ((weekday - now.getDay() + 6) % 7) + 1;
      return { index: match.index, length: match[0].length, offset };
    }
  }
  return null;
}

function findTime(text: string): (Hit & { readonly hour: number; readonly minute: number }) | null {
  const twelve = TIME_12.exec(text);
  if (twelve) {
    const hour = Number(twelve[1]);
    const minute = twelve[2] === undefined ? 0 : Number(twelve[2]);
    if (hour >= 1 && hour <= 12 && minute <= 59) {
      const pm = new RegExp(`^(?:${PM})$`, 'iu').test(twelve[3] ?? '');
      return {
        index: twelve.index,
        length: twelve[0].length,
        hour: (hour % 12) + (pm ? 12 : 0),
        minute,
      };
    }
  }
  const full = TIME_24.exec(text);
  if (full) {
    return {
      index: full.index,
      length: full[0].length,
      hour: Number(full[1]),
      minute: Number(full[2]),
    };
  }
  return null;
}

/** Read a due date out of a quick-add title, or `null` when it names none. */
export function parseQuickDate(input: string, now: Date = new Date()): QuickDate | null {
  const text = asciiDigits(input);
  const day = findDay(text, now);
  // Blank the day words first so a time is not read out of them.
  const rest =
    day === null
      ? text
      : text.slice(0, day.index) + ' '.repeat(day.length) + text.slice(day.index + day.length);
  const time = findTime(rest);
  if (day === null && time === null) return null;

  const cuts = [day, time].filter((hit): hit is NonNullable<typeof hit> => hit !== null);
  cuts.sort((a, b) => b.index - a.index);
  let title = input;
  for (const cut of cuts)
    title = title.slice(0, cut.index) + ' ' + title.slice(cut.index + cut.length);
  title = title
    .replace(/\s+/g, ' ')
    .replace(/\s+([,.;:!?،؛])/g, '$1')
    .replace(/^[\s,.;:،؛-]+|[\s,;:،؛-]+$/g, '')
    .trim();
  if (title === '') return null;

  let offset = day?.offset ?? 0;
  // A time alone that has already passed today means tomorrow.
  if (day === null && time !== null) {
    const minutesNow = now.getHours() * 60 + now.getMinutes();
    if (time.hour * 60 + time.minute <= minutesNow) offset = 1;
  }
  return {
    title,
    day: localDay(addDays(now, offset)),
    time: time === null ? null : { hour: time.hour, minute: time.minute },
  };
}

/** The `dueAt` instant for a parsed date: the local time when one was written, else noon UTC. */
export function quickDateInstant(parsed: QuickDate): string {
  if (parsed.time === null) return `${parsed.day}T12:00:00.000Z`;
  const [year, month, day] = parsed.day.split('-').map(Number);
  return new Date(
    year ?? 0,
    (month ?? 1) - 1,
    day ?? 1,
    parsed.time.hour,
    parsed.time.minute,
  ).toISOString();
}
