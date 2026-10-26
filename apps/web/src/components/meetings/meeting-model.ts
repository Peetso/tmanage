/**
 * 0237 slice C. The pure rules behind the meetings screens: the calendar windows (day, week,
 * month), where a meeting sits in the week grid, the repeat (RRULE) presets and their wording,
 * reminders, and the counts a card shows. No React, no network — each rule is provable alone.
 */

export type CalendarRange = 'day' | 'week' | 'month';

/** 00:00 local on the same calendar day. */
export function startOfDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

export function addDays(date: Date, days: number): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days);
}

/** Monday 00:00 of the week holding `date` (the design's weeks start on Monday). */
export function startOfWeek(date: Date): Date {
  const day = startOfDay(date);
  return addDays(day, -((day.getDay() + 6) % 7));
}

/** `YYYY-MM-DD` in the reader's zone — the key meetings are grouped under. */
export function dayKey(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** The days a range shows: one, seven (Mon–Sun), or the whole weeks covering the month. */
export function daysOf(range: CalendarRange, anchor: Date): readonly Date[] {
  if (range === 'day') return [startOfDay(anchor)];
  if (range === 'week') {
    const monday = startOfWeek(anchor);
    return Array.from({ length: 7 }, (_, i) => addDays(monday, i));
  }
  const first = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
  const last = new Date(anchor.getFullYear(), anchor.getMonth() + 1, 0);
  const start = startOfWeek(first);
  const end = addDays(startOfWeek(last), 7);
  const days: Date[] = [];
  for (let d = start; d < end; d = addDays(d, 1)) days.push(d);
  return days;
}

/** The `from`/`to` instants the list read asks for: the range's first day to the day after its last. */
export function windowOf(
  range: CalendarRange,
  anchor: Date,
): { readonly from: string; readonly to: string } {
  const days = daysOf(range, anchor);
  const first = days[0] ?? startOfDay(anchor);
  const last = days[days.length - 1] ?? first;
  return { from: first.toISOString(), to: addDays(last, 1).toISOString() };
}

/** Step the anchor one range back (-1) or forward (+1). */
export function stepAnchor(range: CalendarRange, anchor: Date, direction: -1 | 1): Date {
  if (range === 'day') return addDays(anchor, direction);
  if (range === 'week') return addDays(anchor, 7 * direction);
  return new Date(anchor.getFullYear(), anchor.getMonth() + direction, 1);
}

/** The week grid's hours: 09:00 to 17:00 by default, widened to hold every meeting shown. */
export function gridHours(meetings: readonly { startsAt: string; endsAt: string | null }[]): {
  readonly first: number;
  readonly last: number;
} {
  let first = 9;
  let last = 17;
  for (const meeting of meetings) {
    const start = new Date(meeting.startsAt);
    const end = meeting.endsAt ? new Date(meeting.endsAt) : new Date(start.getTime() + 3_600_000);
    first = Math.min(first, start.getHours());
    last = Math.max(last, end.getHours() + (end.getMinutes() > 0 ? 1 : 0));
  }
  return { first, last: Math.min(24, Math.max(last, first + 1)) };
}

/** Where a meeting block sits in a day column: top and height in pixels at `hourHeight`. */
export function blockPosition(
  startsAt: string,
  endsAt: string | null,
  firstHour: number,
  hourHeight: number,
): { readonly top: number; readonly height: number } {
  const start = new Date(startsAt);
  const end = endsAt ? new Date(endsAt) : new Date(start.getTime() + 3_600_000);
  const startMinutes = (start.getHours() - firstHour) * 60 + start.getMinutes();
  const minutes = Math.max(30, (end.getTime() - start.getTime()) / 60_000);
  return {
    top: (startMinutes / 60) * hourHeight,
    height: Math.max(hourHeight / 2, (minutes / 60) * hourHeight) - 4,
  };
}

// ── Answers ───────────────────────────────────────────────────────────────

export interface AnswerCounts {
  readonly yes: number;
  readonly maybe: number;
  readonly no: number;
  readonly awaiting: number;
  readonly total: number;
}

export function answerCounts(people: readonly { readonly rsvp: string }[]): AnswerCounts {
  let yes = 0;
  let maybe = 0;
  let no = 0;
  let awaiting = 0;
  for (const person of people) {
    if (person.rsvp === 'accepted') yes += 1;
    else if (person.rsvp === 'tentative') maybe += 1;
    else if (person.rsvp === 'declined') no += 1;
    else awaiting += 1;
  }
  return { yes, maybe, no, awaiting, total: people.length };
}

// ── Repeat (RRULE) ──────────────────────────────────────────────────────────

export type RepeatFrequency = 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'YEARLY';
export const WEEKDAYS = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'] as const;
export type Weekday = (typeof WEEKDAYS)[number];

export interface RepeatRule {
  readonly freq: RepeatFrequency;
  readonly interval: number;
  /** Weekly: the days; monthly: one `-1MO` / `2TU` style day; empty = the start's own day. */
  readonly byDay: readonly string[];
  /** `YYYY-MM-DD`, inclusive. */
  readonly until: string | null;
  readonly count: number | null;
}

/** The start's weekday as an RRULE day (`MO`…`SU`). */
export function weekdayOf(date: Date): Weekday {
  return WEEKDAYS[(date.getDay() + 6) % 7] ?? 'MO';
}

/** "last Monday" when the start is in the month's last seven days, else "2nd Monday" (`2MO`). */
export function monthlyDayOf(date: Date): string {
  const lastDay = new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate();
  if (date.getDate() + 7 > lastDay) return `-1${weekdayOf(date)}`;
  return `${Math.ceil(date.getDate() / 7)}${weekdayOf(date)}`;
}

/** The menu's presets for a meeting starting at `start`. */
export function repeatPresets(
  start: Date,
): Record<'daily' | 'weekly' | 'monthly' | 'yearly' | 'weekdays', RepeatRule> {
  const base = { interval: 1, until: null, count: null };
  return {
    daily: { ...base, freq: 'DAILY', byDay: [] },
    weekly: { ...base, freq: 'WEEKLY', byDay: [weekdayOf(start)] },
    monthly: { ...base, freq: 'MONTHLY', byDay: [monthlyDayOf(start)] },
    yearly: { ...base, freq: 'YEARLY', byDay: [] },
    weekdays: { ...base, freq: 'WEEKLY', byDay: ['MO', 'TU', 'WE', 'TH', 'FR'] },
  };
}

/** The RRULE body the API takes (no `RRULE:` prefix). */
export function buildRrule(rule: RepeatRule): string {
  const parts = [`FREQ=${rule.freq}`];
  if (rule.interval > 1) parts.push(`INTERVAL=${rule.interval}`);
  if (rule.byDay.length > 0) parts.push(`BYDAY=${rule.byDay.join(',')}`);
  if (rule.until) parts.push(`UNTIL=${rule.until.replace(/-/g, '')}T235959Z`);
  else if (rule.count) parts.push(`COUNT=${rule.count}`);
  return parts.join(';');
}

/** Read an RRULE back into the form's rule; `null` for anything the form does not draw. */
export function parseRrule(raw: string | null): RepeatRule | null {
  if (!raw) return null;
  const fields = new Map<string, string>();
  for (const part of raw.replace(/^RRULE:/i, '').split(';')) {
    const [key, value] = part.split('=');
    if (key && value) fields.set(key.toUpperCase(), value.toUpperCase());
  }
  const freq = fields.get('FREQ');
  if (freq !== 'DAILY' && freq !== 'WEEKLY' && freq !== 'MONTHLY' && freq !== 'YEARLY') return null;
  const until = fields.get('UNTIL');
  const count = Number(fields.get('COUNT'));
  return {
    freq,
    interval: Math.max(1, Number(fields.get('INTERVAL') ?? '1') || 1),
    byDay: fields.get('BYDAY')?.split(',') ?? [],
    until: until ? `${until.slice(0, 4)}-${until.slice(4, 6)}-${until.slice(6, 8)}` : null,
    count: Number.isInteger(count) && count > 0 ? count : null,
  };
}

/** Which menu entry a rule is, for the Repeat menu's tick. */
export function presetOf(
  rule: RepeatRule | null,
  start: Date,
): 'none' | 'daily' | 'weekly' | 'monthly' | 'yearly' | 'weekdays' | 'custom' {
  if (!rule) return 'none';
  const presets = repeatPresets(start);
  for (const key of ['daily', 'weekly', 'monthly', 'yearly', 'weekdays'] as const) {
    if (buildRrule(presets[key]) === buildRrule(rule)) return key;
  }
  return 'custom';
}

/** How many meetings a rule makes up to its `until` (weekly/daily only; else `null`). */
export function occurrenceCount(rule: RepeatRule, start: Date): number | null {
  if (rule.count) return rule.count;
  if (!rule.until) return null;
  const until = new Date(`${rule.until}T23:59:59`);
  if (Number.isNaN(until.getTime()) || until < start) return 0;
  const days = Math.floor((startOfDay(until).getTime() - startOfDay(start).getTime()) / 86_400_000);
  if (rule.freq === 'DAILY') return Math.floor(days / rule.interval) + 1;
  if (rule.freq === 'WEEKLY') {
    const perWeek = Math.max(1, rule.byDay.length);
    return (Math.floor(days / (7 * rule.interval)) + 1) * perWeek;
  }
  return null;
}

// ── Reminders ───────────────────────────────────────────────────────────────

export type ReminderUnit = 'minutes' | 'hours' | 'days' | 'weeks';
const UNIT_MINUTES: Record<ReminderUnit, number> = {
  minutes: 1,
  hours: 60,
  days: 1440,
  weeks: 10_080,
};

export function reminderMinutes(amount: number, unit: ReminderUnit): number {
  return Math.max(0, Math.round(amount)) * UNIT_MINUTES[unit];
}

/** 1440 → `{ amount: 1, unit: 'days' }` — the largest unit that divides the minutes. */
export function splitReminder(minutes: number): { amount: number; unit: ReminderUnit } {
  for (const unit of ['weeks', 'days', 'hours'] as const) {
    if (minutes > 0 && minutes % UNIT_MINUTES[unit] === 0) {
      return { amount: minutes / UNIT_MINUTES[unit], unit };
    }
  }
  return { amount: minutes, unit: 'minutes' };
}

// ── Time ────────────────────────────────────────────────────────────────────

/** "11:30" in the reader's zone, 24-hour. */
export function clock(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

/** "11:30 – 12:30" (or the start alone when no end was recorded). */
export function timeRange(startsAt: string, endsAt: string | null): string {
  return endsAt ? `${clock(startsAt)} – ${clock(endsAt)}` : clock(startsAt);
}

/** "GMT+3" for the reader's zone at `date`. */
export function gmtOffset(date: Date): string {
  const minutes = -date.getTimezoneOffset();
  const sign = minutes >= 0 ? '+' : '-';
  const abs = Math.abs(minutes);
  const hours = Math.floor(abs / 60);
  const rest = abs % 60;
  return `GMT${sign}${hours}${rest ? `:${String(rest).padStart(2, '0')}` : ''}`;
}

/** Google's event colours 1–11, drawn as the form's swatches. */
export const MEETING_COLOURS: readonly { readonly id: string; readonly hex: string }[] = [
  { id: '11', hex: '#d50000' },
  { id: '4', hex: '#e67c73' },
  { id: '6', hex: '#f4511e' },
  { id: '5', hex: '#f6bf26' },
  { id: '2', hex: '#33b679' },
  { id: '10', hex: '#0b8043' },
  { id: '7', hex: '#039be5' },
  { id: '9', hex: '#3f51b5' },
  { id: '1', hex: '#7986cb' },
  { id: '3', hex: '#8e24aa' },
  { id: '8', hex: '#616161' },
];
