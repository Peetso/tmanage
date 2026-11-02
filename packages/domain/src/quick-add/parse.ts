import {
  addWorkingDays,
  dayNumberOf,
  isIsoDate,
  isWorkingDay,
  isoDateOfDayNumber,
  nthWorkingDay,
  weekdayOf,
} from '../calendar/working-calendar.js';
import type { WorkingCalendar } from '../calendar/working-calendar.js';
import { nameMatches } from './normalize.js';
import { toLatinDigits } from './numerals.js';
import {
  ARABIC_DAY_DUAL,
  ARABIC_DAY_UNITS,
  ARABIC_DURATIONS,
  ARABIC_HOURS,
  ARABIC_IN,
  ARABIC_MINUTES,
  ARABIC_PROJECT_MARKER,
  ARABIC_WEEK_DUAL,
  ARABIC_WEEK_UNITS,
  ARABIC_WORKING,
  DATE_PREFIX,
  ENGLISH_DURATIONS,
  ENGLISH_PROJECT_MARKER,
  ESTIMATE_PREFIX,
  MONTH_WORDS,
  NUMBER_WORDS,
  PRIORITY_WORDS,
  RELATIVE_DATE_WORDS,
  WEEKDAY_AFTER,
  WEEKDAY_BEFORE,
  WEEKDAY_DAY_WORD,
  WEEKDAY_WORDS,
  WORD_EDGE,
  arabicWord,
} from './tokens.js';
import type { QuickAddPriority, RelativeDate } from './tokens.js';

/**
 * 55-25 — the quick-add parser: one line of English, Arabic or both in, a title and typed tokens
 * out. Pure and deterministic: no clock (the caller passes `today` in the company's zone), no
 * network, no `Intl`; dates come from the company's {@link WorkingCalendar}.
 *
 * - **Owner** `@name`, "for Sara", «لسارة» (the «ل» is stripped; «للعنود» is «العنود»).
 * - **Project** `#slug-or-name`, "in project …", «في مشروع …».
 * - **Date** today / tomorrow / day after / next week / weekdays / end of week / end of month /
 *   "in N days" / d/m, d/m/yyyy, yyyy-mm-dd and month names, in either digit set. A date never
 *   lands on a non-working day: it moves forward to the next working one. A weekday that is
 *   today means next week's. "Next week" is the first working day of next week.
 * - **Priority** `p1|p2|p3`, urgent / important, «عاجل» = p1, «مهم» = p2.
 * - **Estimate** `2h`, `30m`, `1h30m`, «ساعتين», «ساعة», «نصف ساعة», «٣ ساعات».
 *
 * Names: when `people` / `projects` are given, a name that matches none of them is not a token
 * and stays in the title; `@` and `#` are then checked too. Without the lists only the explicit
 * `@` / `#` forms are tokens. Numeric dates are day-first (d/m) in every locale.
 *
 * The title is the text minus every consumed span, spaces collapsed and trimmed; bidi marks
 * stay. One token per kind: a second date (say) stays in the title.
 */

export type QuickAddTokenKind = 'owner' | 'project' | 'date' | 'priority' | 'estimate';

interface TokenBase {
  /** The text consumed, exactly as typed. */
  readonly raw: string;
  /** `[start, end)` in the input string (UTF-16 indices). */
  readonly span: readonly [number, number];
}

export type QuickAddToken =
  | (TokenBase & { readonly kind: 'owner' | 'project' | 'date'; readonly value: string })
  | (TokenBase & { readonly kind: 'priority'; readonly value: QuickAddPriority })
  | (TokenBase & { readonly kind: 'estimate'; readonly value: number });

export interface QuickAddResult {
  readonly title: string;
  readonly tokens: readonly QuickAddToken[];
}

export interface QuickAddOptions {
  /** The company's civil date now (`YYYY-MM-DD`). */
  readonly today: string;
  readonly calendar: WorkingCalendar;
  /** Accepted for the API's shape; parsing is bilingual whatever it says. */
  readonly locale?: 'en' | 'ar';
  /** Names the caller may assign to; omit to accept any `@name`. */
  readonly people?: readonly string[];
  /** Project names the caller may read; omit to accept any `#project`. */
  readonly projects?: readonly string[];
  /** First day of the week (0 = Sunday); default: the first day of the calendar's working run. */
  readonly weekStart?: number;
}

/** Longest input the parser reads; the API refuses anything over 300 characters before this. */
export const QUICK_ADD_MAX_LENGTH = 1000;
const MAX_NAME_WORDS = 3;
const MAX_RELATIVE_DAYS = 366;

const START = `(?<=^|${WORD_EDGE})`;
const END = `(?=$|${WORD_EDGE})`;

function bounded(body: string): RegExp {
  return new RegExp(`${START}(?:${body})${END}`, 'giu');
}

type DateRule =
  | { readonly kind: 'relative'; readonly value: RelativeDate }
  | { readonly kind: 'weekday'; readonly value: number }
  | { readonly kind: 'offset'; readonly days: number; readonly working: boolean }
  | {
      readonly kind: 'absolute';
      readonly year: number | null;
      readonly month: number;
      readonly day: number;
    };

interface Hit {
  readonly start: number;
  readonly end: number;
  readonly kind: QuickAddTokenKind;
  readonly value: string | number;
}

const NUMBER = `\\d{1,3}|${NUMBER_WORDS.map((entry) => entry.pattern).join('|')}`;

function numberOf(text: string | undefined): number | null {
  if (text === undefined) return null;
  const latin = toLatinDigits(text.trim());
  if (/^\d+$/.test(latin)) return Number(latin);
  for (const entry of NUMBER_WORDS) {
    if (new RegExp(`^(?:${entry.pattern})$`, 'iu').test(latin)) return entry.value;
  }
  return null;
}

// --- compiled once -------------------------------------------------------------------------

const RELATIVE_RULES = RELATIVE_DATE_WORDS.map((entry) => ({
  re: bounded(`${DATE_PREFIX}(?:${entry.pattern})`),
  value: entry.value,
}));

const WEEKDAY_RULES = WEEKDAY_WORDS.map((entry) => ({
  re: bounded(
    `${DATE_PREFIX}${WEEKDAY_DAY_WORD}${WEEKDAY_BEFORE}(?:${entry.pattern})${WEEKDAY_AFTER}`,
  ),
  value: entry.value,
}));

const EN_OFFSET = bounded(
  `${DATE_PREFIX}(?:in|within)\\s+(${NUMBER})\\s+(working\\s+days?|business\\s+days?|days?|weeks?)`,
);
const AR_OFFSET = bounded(
  `(?:${ARABIC_IN})\\s+(?:(${NUMBER})\\s+)?(${ARABIC_DAY_DUAL}|${ARABIC_WEEK_DUAL}|${ARABIC_DAY_UNITS}|${ARABIC_WEEK_UNITS})(\\s+${ARABIC_WORKING})?`,
);

const ISO_NUMERIC = bounded(`${DATE_PREFIX}(\\d{4})-(\\d{1,2})-(\\d{1,2})`);
const DM_NUMERIC = bounded(`${DATE_PREFIX}(\\d{1,2})/(\\d{1,2})(?:/(\\d{4}|\\d{2}))?`);

const ORDINAL = '(?:st|nd|rd|th)?';
const MONTH_RULES = MONTH_WORDS.flatMap((entry) => [
  {
    re: bounded(
      `${DATE_PREFIX}(?:the\\s+)?(\\d{1,2})${ORDINAL}\\s+(?:of\\s+)?(?:${entry.pattern})(?:,?\\s+(\\d{4}))?`,
    ),
    month: entry.value,
  },
  {
    re: bounded(`${DATE_PREFIX}(?:${entry.pattern})\\s+(\\d{1,2})${ORDINAL}(?:,?\\s+(\\d{4}))?`),
    month: entry.value,
  },
]);

const PRIORITY_RULES = PRIORITY_WORDS.map((entry) => ({
  re: bounded(`(?:priority\\s+)?(?:${entry.pattern})`),
  value: entry.value,
}));

const EN_HOURS = bounded(
  `${ESTIMATE_PREFIX}(\\d{1,3}(?:\\.\\d{1,2})?)\\s?(?:h|hrs?|hours?)(?:\\s?(\\d{1,2})\\s?(?:m|mins?|minutes?)|(\\d{2}))?`,
);
const EN_MINUTES = bounded(`${ESTIMATE_PREFIX}(\\d{1,3})\\s?(?:m|mins?|minutes?)`);
const EN_WORD_HOURS = bounded(`${ESTIMATE_PREFIX}(${NUMBER})\\s+hours?`);
const EN_FIXED = ENGLISH_DURATIONS.map((entry) => ({
  re: bounded(`${ESTIMATE_PREFIX}(?:${entry.pattern})`),
  value: entry.value,
}));
const AR_COUNT_HOURS = bounded(`${ESTIMATE_PREFIX}(${NUMBER})\\s*(?:${ARABIC_HOURS})`);
const AR_COUNT_MINUTES = bounded(`${ESTIMATE_PREFIX}(${NUMBER})\\s*(?:${ARABIC_MINUTES})`);
const AR_FIXED = ARABIC_DURATIONS.map((entry) => ({
  re: bounded(`${ESTIMATE_PREFIX}(?:${entry.pattern})`),
  value: entry.value,
}));

const NAME_CHARS = '[^\\s@#,،;:!?()«»"\\u200E\\u200F]';
const AT_NAME = bounded(`@(${NAME_CHARS}*[^\\s@#,،;:!?()«»"\\u200E\\u200F.])`);
const HASH_NAME = bounded(`#(${NAME_CHARS}*[^\\s@#,،;:!?()«»"\\u200E\\u200F.])`);
const EN_FOR = new RegExp(`${START}for\\s+`, 'giu');
const AR_LAM = new RegExp(`${START}${arabicWord('ل')}(?=[\\u0621-\\u064A])`, 'gu');
const EN_PROJECT = new RegExp(`${START}${ENGLISH_PROJECT_MARKER}`, 'giu');
const AR_PROJECT = new RegExp(`${START}${ARABIC_PROJECT_MARKER}`, 'gu');
const WORD = /[^\s,،;:!?()«»"]+/uy;
const GAP = /[ \t\u00A0]+/uy;

// --- dates ---------------------------------------------------------------------------------

function addDays(date: string, days: number): string {
  return isoDateOfDayNumber(dayNumberOf(date) + days);
}

/** The first working day on or after `date`. */
function forward(date: string, calendar: WorkingCalendar): string {
  return nthWorkingDay(date, 1, calendar);
}

/** The last working day in `[notBefore, end]`, or null. */
function lastWorkingWithin(
  end: string,
  notBefore: string,
  calendar: WorkingCalendar,
): string | null {
  for (let day = end; day >= notBefore; day = addDays(day, -1)) {
    if (isWorkingDay(day, calendar)) return day;
  }
  return null;
}

function weekStartOf(calendar: WorkingCalendar, explicit: number | undefined): number {
  if (explicit !== undefined && Number.isInteger(explicit) && explicit >= 0 && explicit <= 6) {
    return explicit;
  }
  const working = (day: number): boolean => (calendar.workingDaysMask & (1 << day)) !== 0;
  for (let day = 0; day < 7; day += 1) {
    if (working(day) && !working((day + 6) % 7)) return day;
  }
  return 0;
}

function monthEndOf(date: string): string {
  const year = Number(date.slice(0, 4));
  const month = Number(date.slice(5, 7));
  const next =
    month === 12 ? `${year + 1}-01-01` : `${year}-${String(month + 1).padStart(2, '0')}-01`;
  return addDays(next, -1);
}

function resolveDate(rule: DateRule, options: QuickAddOptions): string | null {
  const { today, calendar } = options;
  switch (rule.kind) {
    case 'relative': {
      const weekStart = weekStartOf(calendar, options.weekStart);
      const thisWeek = addDays(today, -((weekdayOf(today) - weekStart + 7) % 7));
      switch (rule.value) {
        case 'today':
          return forward(today, calendar);
        case 'tomorrow':
          return forward(addDays(today, 1), calendar);
        case 'after_tomorrow':
          return forward(addDays(today, 2), calendar);
        case 'next_week':
          return forward(addDays(thisWeek, 7), calendar);
        case 'end_of_week':
          return (
            lastWorkingWithin(addDays(thisWeek, 6), today, calendar) ?? forward(today, calendar)
          );
        case 'end_of_month': {
          const thisMonth = lastWorkingWithin(monthEndOf(today), today, calendar);
          if (thisMonth !== null) return thisMonth;
          const nextEnd = monthEndOf(addDays(monthEndOf(today), 1));
          return lastWorkingWithin(nextEnd, today, calendar) ?? forward(today, calendar);
        }
      }
      return null;
    }
    case 'weekday': {
      const delta = (rule.value - weekdayOf(today) + 7) % 7 || 7;
      return forward(addDays(today, delta), calendar);
    }
    case 'offset':
      if (rule.days < 0 || rule.days > MAX_RELATIVE_DAYS) return null;
      return rule.working
        ? addWorkingDays(today, rule.days, calendar)
        : forward(addDays(today, rule.days), calendar);
    case 'absolute': {
      const pad = (n: number): string => String(n).padStart(2, '0');
      const thisYear = Number(today.slice(0, 4));
      let iso = `${rule.year ?? thisYear}-${pad(rule.month)}-${pad(rule.day)}`;
      if (!isIsoDate(iso)) return null;
      if (rule.year === null && iso < today) {
        iso = `${thisYear + 1}-${pad(rule.month)}-${pad(rule.day)}`;
        if (!isIsoDate(iso)) return null;
      }
      return forward(iso, calendar);
    }
  }
}

function yearOf(text: string | undefined): number | null {
  if (text === undefined || text === '') return null;
  const n = Number(text);
  return text.length === 2 ? 2000 + n : n;
}

// --- names ---------------------------------------------------------------------------------

interface NameRun {
  readonly name: string;
  readonly end: number;
}

/** Up to {@link MAX_NAME_WORDS} words from `from`, shortest first. */
function namesAt(text: string, from: number): NameRun[] {
  const runs: NameRun[] = [];
  const words: string[] = [];
  let at = from;
  for (let i = 0; i < MAX_NAME_WORDS; i += 1) {
    if (i > 0) {
      GAP.lastIndex = at;
      const gap = GAP.exec(text);
      if (gap === null) break;
      at += gap[0].length;
    }
    WORD.lastIndex = at;
    const match = WORD.exec(text);
    if (match === null) break;
    let word = match[0];
    let end = at + word.length;
    while (word.endsWith('.')) {
      word = word.slice(0, -1);
      end -= 1;
    }
    if (word === '') break;
    words.push(word);
    runs.push({ name: words.join(' '), end });
    if (end !== at + match[0].length) break;
    at = end;
  }
  return runs;
}

function known(name: string, list: readonly string[] | undefined): boolean {
  return list !== undefined && list.some((entry) => nameMatches(name, entry));
}

/** The longest run of words after a marker that names a listed entry. */
function longestKnown(
  text: string,
  from: number,
  list: readonly string[] | undefined,
  rewrite: (name: string) => readonly string[] = (name) => [name],
): NameRun | null {
  const runs = namesAt(text, from);
  for (let i = runs.length - 1; i >= 0; i -= 1) {
    const run = runs[i];
    if (run === undefined) continue;
    for (const name of rewrite(run.name)) {
      if (known(name, list)) return { name, end: run.end };
    }
  }
  return null;
}

function cleanHandle(handle: string): string {
  return handle.replace(/[_.-]+/g, ' ').trim();
}

// --- the parse -----------------------------------------------------------------------------

function collectDates(text: string, options: QuickAddOptions, hits: Hit[]): void {
  const push = (match: RegExpMatchArray, rule: DateRule): void => {
    let value: string | null;
    try {
      value = resolveDate(rule, options);
    } catch {
      value = null; // a calendar with no working day within the horizon: no date token
    }
    if (value === null || match.index === undefined) return;
    hits.push({ start: match.index, end: match.index + match[0].length, kind: 'date', value });
  };
  for (const rule of RELATIVE_RULES) {
    for (const match of text.matchAll(rule.re))
      push(match, { kind: 'relative', value: rule.value });
  }
  for (const rule of WEEKDAY_RULES) {
    for (const match of text.matchAll(rule.re)) push(match, { kind: 'weekday', value: rule.value });
  }
  for (const match of text.matchAll(EN_OFFSET)) {
    const count = numberOf(match[1]);
    const unit = (match[2] ?? '').toLowerCase();
    if (count === null) continue;
    const working = /working|business/.test(unit);
    const days = unit.startsWith('week') ? count * 7 : count;
    push(match, { kind: 'offset', days, working });
  }
  for (const match of text.matchAll(AR_OFFSET)) {
    const unit = match[2] ?? '';
    const dual = new RegExp(`^(?:${ARABIC_DAY_DUAL}|${ARABIC_WEEK_DUAL})$`, 'u').test(unit);
    const week = new RegExp(`^(?:${ARABIC_WEEK_DUAL}|${ARABIC_WEEK_UNITS})$`, 'u').test(unit);
    const count = dual ? (match[1] === undefined ? 2 : null) : (numberOf(match[1]) ?? 1);
    if (count === null) continue;
    push(match, {
      kind: 'offset',
      days: week ? count * 7 : count,
      working: match[3] !== undefined,
    });
  }
  for (const match of text.matchAll(ISO_NUMERIC)) {
    push(match, {
      kind: 'absolute',
      year: Number(match[1]),
      month: Number(match[2]),
      day: Number(match[3]),
    });
  }
  for (const match of text.matchAll(DM_NUMERIC)) {
    push(match, {
      kind: 'absolute',
      year: yearOf(match[3]),
      month: Number(match[2]),
      day: Number(match[1]),
    });
  }
  for (const rule of MONTH_RULES) {
    for (const match of text.matchAll(rule.re)) {
      push(match, {
        kind: 'absolute',
        year: yearOf(match[2]),
        month: rule.month,
        day: Number(match[1]),
      });
    }
  }
}

function collectEstimates(text: string, hits: Hit[]): void {
  const push = (match: RegExpMatchArray, minutes: number | null): void => {
    if (minutes === null || match.index === undefined) return;
    if (!Number.isFinite(minutes) || minutes <= 0 || minutes > 100 * 60) return;
    hits.push({
      start: match.index,
      end: match.index + match[0].length,
      kind: 'estimate',
      value: Math.round(minutes),
    });
  };
  for (const match of text.matchAll(EN_HOURS)) {
    const extra = Number(match[2] ?? match[3] ?? 0);
    push(match, Number(match[1]) * 60 + (extra < 60 ? extra : Number.NaN));
  }
  for (const match of text.matchAll(EN_MINUTES)) push(match, Number(match[1]));
  for (const match of text.matchAll(EN_WORD_HOURS)) {
    const count = numberOf(match[1]);
    push(match, count === null ? null : count * 60);
  }
  for (const rule of EN_FIXED) for (const match of text.matchAll(rule.re)) push(match, rule.value);
  for (const match of text.matchAll(AR_COUNT_HOURS)) {
    const count = numberOf(match[1]);
    push(match, count === null ? null : count * 60);
  }
  for (const match of text.matchAll(AR_COUNT_MINUTES)) push(match, numberOf(match[1]));
  for (const rule of AR_FIXED) for (const match of text.matchAll(rule.re)) push(match, rule.value);
}

function collectNames(text: string, options: QuickAddOptions, hits: Hit[]): void {
  const { people, projects } = options;
  for (const match of text.matchAll(AT_NAME)) {
    const name = cleanHandle(match[1] ?? '');
    if (match.index === undefined || name === '') continue;
    if (people !== undefined && !known(name, people)) continue;
    hits.push({
      start: match.index,
      end: match.index + match[0].length,
      kind: 'owner',
      value: name,
    });
  }
  for (const match of text.matchAll(HASH_NAME)) {
    const name = cleanHandle(match[1] ?? '');
    if (match.index === undefined || name === '') continue;
    if (projects !== undefined && !known(name, projects)) continue;
    hits.push({
      start: match.index,
      end: match.index + match[0].length,
      kind: 'project',
      value: name,
    });
  }
  for (const match of text.matchAll(EN_FOR)) {
    if (match.index === undefined) continue;
    const run = longestKnown(text, match.index + match[0].length, people);
    if (run) hits.push({ start: match.index, end: run.end, kind: 'owner', value: run.name });
  }
  for (const match of text.matchAll(AR_LAM)) {
    if (match.index === undefined) continue;
    // «للعنود» is «ل» + «العنود»: the article's alef is dropped after the preposition.
    const run = longestKnown(text, match.index + match[0].length, people, (name) =>
      name.startsWith('ل') ? [`ا${name}`, name] : [name],
    );
    if (run) hits.push({ start: match.index, end: run.end, kind: 'owner', value: run.name });
  }
  for (const re of [EN_PROJECT, AR_PROJECT]) {
    for (const match of text.matchAll(re)) {
      if (match.index === undefined) continue;
      const run = longestKnown(text, match.index + match[0].length, projects);
      if (run) hits.push({ start: match.index, end: run.end, kind: 'project', value: run.name });
    }
  }
}

function collectPriorities(text: string, hits: Hit[]): void {
  for (const rule of PRIORITY_RULES) {
    for (const match of text.matchAll(rule.re)) {
      if (match.index === undefined) continue;
      hits.push({
        start: match.index,
        end: match.index + match[0].length,
        kind: 'priority',
        value: rule.value,
      });
    }
  }
}

/** Earliest first, longest first; no overlaps; one per kind. */
function choose(hits: readonly Hit[]): Hit[] {
  const sorted = [...hits].sort((a, b) => a.start - b.start || b.end - a.end);
  const chosen: Hit[] = [];
  const kinds = new Set<QuickAddTokenKind>();
  let lastEnd = 0;
  for (const hit of sorted) {
    if (hit.start < lastEnd) continue;
    if (kinds.has(hit.kind)) continue;
    chosen.push(hit);
    kinds.add(hit.kind);
    lastEnd = hit.end;
  }
  return chosen;
}

function titleWithout(text: string, spans: readonly Hit[]): string {
  let out = '';
  let at = 0;
  for (const span of spans) {
    out += `${text.slice(at, span.start)} `;
    at = span.end;
  }
  out += text.slice(at);
  let title = out
    .replace(/\(\s*\)|\[\s*\]/g, ' ')
    .replace(/[ \t\u00A0]+/g, ' ')
    .replace(/ ([,،;:.!?])/g, '$1');
  // Leading / trailing separators a removed token leaves behind; bidi marks are kept.
  let previous = '';
  while (previous !== title) {
    previous = title;
    title = title
      .trim()
      .replace(/^[,،;:\-–—]+/, '')
      .replace(/[,،;:\-–—]+$/, '');
  }
  return title;
}

export function parseQuickAdd(input: string, options: QuickAddOptions): QuickAddResult {
  const text = input.slice(0, QUICK_ADD_MAX_LENGTH);
  // Same length as `text`: every index found on `latin` is an index into `text`.
  const latin = toLatinDigits(text);
  const hits: Hit[] = [];
  collectNames(latin, options, hits);
  collectDates(latin, options, hits);
  collectPriorities(latin, hits);
  collectEstimates(latin, hits);
  const chosen = choose(hits);
  const tokens = chosen.map((hit): QuickAddToken => {
    const base = { raw: text.slice(hit.start, hit.end), span: [hit.start, hit.end] as const };
    if (hit.kind === 'estimate') return { ...base, kind: 'estimate', value: Number(hit.value) };
    if (hit.kind === 'priority') {
      return { ...base, kind: 'priority', value: hit.value as QuickAddPriority };
    }
    return { ...base, kind: hit.kind, value: String(hit.value) };
  });
  return { title: titleWithout(text, chosen), tokens };
}
