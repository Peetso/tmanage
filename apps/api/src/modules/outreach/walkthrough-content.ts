import { randomBytes } from 'node:crypto';
import { CONTACT_EMAILS } from '@tmanage/domain';
import { mailEyebrow, renderMailLayout } from '@tmanage/mail';
import type { MailMessage } from '@tmanage/mail';
import { ApiError, type ApiErrorDetail } from '../../common/http/errors.js';

/**
 * LANE-Q — the "Book a walkthrough" request: the one parser of its body (IP-2: parse once, at the
 * boundary) and the words of the mail the sales team receives. Pure: no I/O, unit-tested.
 *
 * The body is client-held, so every field is re-checked here: lengths match the 0388 columns, the
 * three times are `YYYY-MM-DDTHH:MM` wall-clock values that really exist, are distinct and lie in
 * the next 90 days in the visitor's own time zone (an IANA name the runtime knows), topics come
 * from a closed list, and the consent line must be ticked (the request asks to be answered by
 * e-mail; without consent nothing is stored).
 */

export const WALKTHROUGH_TEAM_SIZES = ['1-10', '11-50', '51-200', '200+'] as const;
export type WalkthroughTeamSize = (typeof WALKTHROUGH_TEAM_SIZES)[number];
export const WALKTHROUGH_TOPICS = ['tour', 'switch', 'future'] as const;
export type WalkthroughTopic = (typeof WALKTHROUGH_TOPICS)[number];

export const MAX_WALKTHROUGH_NAME = 120;
export const MAX_WALKTHROUGH_EMAIL = 254;
export const MAX_WALKTHROUGH_COMPANY = 160;
/** The whole body, as JSON: a short form, never an essay. */
export const MAX_WALKTHROUGH_BYTES = 4_096;
/** How far ahead a preferred time may be. */
export const WALKTHROUGH_HORIZON_DAYS = 90;

export interface WalkthroughInput {
  readonly name: string;
  readonly email: string;
  readonly company: string;
  readonly teamSize: WalkthroughTeamSize;
  readonly timeZone: string;
  /** Three distinct `YYYY-MM-DDTHH:MM` wall-clock times in `timeZone`, in the visitor's order. */
  readonly slots: readonly [string, string, string];
  readonly topics: readonly WalkthroughTopic[];
  readonly language: 'en' | 'ar';
  /** `utm_source` of the page's own address (NOCOOKIE), checked against the shared pattern. */
  readonly source: string | null;
}

const EMAIL_SHAPE = /^[^\s@<>"(),;:\\]{1,64}@[^\s@<>"(),;:\\]{1,189}$/u;
const SLOT_SHAPE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/u;
const SOURCE_SHAPE = /^[A-Za-z0-9_.-]{1,32}$/u;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/u;
const REFERENCE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/** A short reference the visitor can quote: `WT-` and eight unambiguous characters. */
export function newWalkthroughReference(): string {
  let out = 'WT-';
  for (const byte of randomBytes(8)) out += REFERENCE_ALPHABET[byte % REFERENCE_ALPHABET.length];
  return out;
}

/** The hidden `website` field: a person never sees it, a script that fills every field does. */
export function walkthroughHoneypotFilled(body: Readonly<Record<string, unknown>>): boolean {
  const value = body['website'];
  if (value === undefined || value === null) return false;
  return typeof value !== 'string' || value.trim() !== '';
}

/** Whether the runtime knows `zone` as an IANA time zone. */
export function isKnownTimeZone(zone: string): boolean {
  if (zone.length < 1 || zone.length > 64 || !/^[A-Za-z0-9_+\-/]+$/u.test(zone)) return false;
  try {
    new Intl.DateTimeFormat('en', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/** The UTC instant of a wall-clock time in `zone` (the offset at that moment, DST included). */
export function wallClockToInstant(slot: string, zone: string): Date | null {
  const match = SLOT_SHAPE.exec(slot);
  if (match === null) return null;
  const [y, mo, d, h, mi] = match.slice(1).map(Number) as [number, number, number, number, number];
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59) return null;
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  const check = new Date(guess);
  if (check.getUTCDate() !== d || check.getUTCMonth() !== mo - 1) return null;
  // Two passes of "what does that instant read as in the zone" converge on the offset.
  let instant = guess;
  for (let pass = 0; pass < 2; pass += 1) {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    }).formatToParts(new Date(instant));
    const get = (type: string): number => Number(parts.find((p) => p.type === type)?.value);
    const shown = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'));
    instant += guess - shown;
  }
  return new Date(instant);
}

function text(
  raw: unknown,
  field: string,
  max: number,
  details: ApiErrorDetail[],
  message: string,
): string {
  // The control check reads the raw text: collapsing whitespace first would turn a CR/LF header
  // injection into a harmless-looking space and let it through.
  const original = typeof raw === 'string' ? raw.trim() : '';
  const value = original.replace(/\s+/gu, ' ');
  if (value === '') details.push({ field, message });
  else if (value.length > max)
    details.push({ field, message: `at most ${String(max)} characters` });
  else if (CONTROL.test(original)) details.push({ field, message: 'contains a control character' });
  return value;
}

/** Parse the body once; every problem is reported at once (422), so the page marks each field. */
export function parseWalkthroughRequest(
  body: Readonly<Record<string, unknown>>,
  now: Date,
): WalkthroughInput {
  const details: ApiErrorDetail[] = [];
  const name = text(body['name'], 'name', MAX_WALKTHROUGH_NAME, details, 'Your name is required.');
  const email = text(
    body['email'],
    'email',
    MAX_WALKTHROUGH_EMAIL,
    details,
    'Enter your work e-mail.',
  ).toLowerCase();
  if (email !== '' && !EMAIL_SHAPE.test(email)) {
    details.push({ field: 'email', message: 'Enter a valid e-mail address.' });
  }
  const company = text(
    body['company'],
    'company',
    MAX_WALKTHROUGH_COMPANY,
    details,
    'The company name is required.',
  );
  const teamSize = (WALKTHROUGH_TEAM_SIZES as readonly unknown[]).includes(body['teamSize'])
    ? (body['teamSize'] as WalkthroughTeamSize)
    : null;
  if (teamSize === null) details.push({ field: 'teamSize', message: 'Choose a team size.' });

  const timeZone = typeof body['timeZone'] === 'string' ? body['timeZone'] : '';
  const zoneOk = isKnownTimeZone(timeZone);
  if (!zoneOk) details.push({ field: 'timeZone', message: 'Choose your time zone.' });

  const rawSlots = Array.isArray(body['slots']) ? (body['slots'] as unknown[]) : [];
  const slots: string[] = [];
  const horizon = now.getTime() + WALKTHROUGH_HORIZON_DAYS * 86_400_000;
  for (let i = 0; i < 3; i += 1) {
    const raw = rawSlots[i];
    const slot = typeof raw === 'string' ? raw.trim() : '';
    const at = zoneOk ? wallClockToInstant(slot, timeZone) : null;
    if (at === null || at.getTime() <= now.getTime() || at.getTime() > horizon) {
      details.push({ field: `slots.${String(i)}`, message: 'Pick a time in the next 90 days.' });
    } else if (slots.includes(slot)) {
      details.push({ field: `slots.${String(i)}`, message: 'Pick three different times.' });
    }
    slots.push(slot);
  }
  if (rawSlots.length !== 3) details.push({ field: 'slots', message: 'Pick three times.' });

  const rawTopics = Array.isArray(body['topics']) ? (body['topics'] as unknown[]) : [];
  const topics = WALKTHROUGH_TOPICS.filter((topic) => rawTopics.includes(topic));
  if (topics.length === 0 || rawTopics.length !== topics.length) {
    details.push({ field: 'topics', message: 'Choose at least one topic.' });
  }
  if (body['consent'] !== true) {
    details.push({ field: 'consent', message: 'Tick the line so we may answer you by e-mail.' });
  }
  if (details.length > 0 || teamSize === null) {
    throw new ApiError(422, 'validation_failed', 'The request is incomplete.', details);
  }
  const source =
    typeof body['source'] === 'string' && SOURCE_SHAPE.test(body['source']) ? body['source'] : null;
  return {
    name,
    email,
    company,
    teamSize,
    timeZone,
    slots: [slots[0] as string, slots[1] as string, slots[2] as string],
    topics,
    language: body['language'] === 'ar' ? 'ar' : 'en',
    source,
  };
}

const TOPIC_LABELS: Readonly<Record<WalkthroughTopic, string>> = {
  tour: 'A tour of TManage',
  switch: 'Why switch from their current tool',
  future: 'Future features',
};

/** "Tue 25 Nov 2026, 10:00 (Africa/Cairo) = 08:00 UTC" for the sales team. */
function describeSlot(slot: string, zone: string): string {
  const at = wallClockToInstant(slot, zone);
  if (at === null) return slot;
  const local = new Intl.DateTimeFormat('en-GB', {
    timeZone: zone,
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(at);
  return `${local} (${zone}) = ${at.toISOString().slice(11, 16)} UTC`;
}

/**
 * The mail to sales@, from sales@ (template `walkthrough_request` → sender category `sales`).
 * Reply-To is the visitor's address, so the team answers with Reply. Internal mail in English.
 */
export function composeSalesNotification(input: WalkthroughInput, reference: string): MailMessage {
  const rows = [
    { label: 'Name', value: input.name },
    { label: 'Work e-mail', value: input.email },
    { label: 'Company', value: input.company },
    { label: 'Team size', value: input.teamSize },
    { label: 'Page language', value: input.language },
    ...(input.source === null ? [] : [{ label: 'Came from', value: input.source }]),
  ];
  const times = [
    'Preferred times, in order:',
    ...input.slots.map((slot, i) => `${String(i + 1)}. ${describeSlot(slot, input.timeZone)}`),
  ];
  const topics = ['Topics:', ...input.topics.map((topic) => `- ${TOPIC_LABELS[topic]}`)];
  const close = [
    'They agreed to be answered by e-mail about this request. Reply to this e-mail to answer',
    'them, and confirm one of the times with a calendar invitation.',
  ];
  const lines = [
    `New walkthrough request ${reference}.`,
    '',
    ...rows.map((row) => `${row.label}: ${row.value}`),
    '',
    ...times,
    '',
    ...topics,
    '',
    ...close,
  ];
  const subject = `Walkthrough request from ${input.company} (${reference})`;
  return {
    to: CONTACT_EMAILS.sales,
    subject,
    text: lines.join('\n'),
    // MAILDESIGN: the sales team's copy in the shared layout too (internal, English only).
    html: renderMailLayout({
      arabic: false,
      subject,
      preheader: `New walkthrough request ${reference}.`,
      eyebrow: mailEyebrow('operations', 'en'),
      heading: `New walkthrough request ${reference}.`,
      blocks: [
        { kind: 'rows', rows },
        { kind: 'text', text: times.join('\n') },
        { kind: 'text', text: topics.join('\n') },
      ],
      note: close.join(' '),
    }),
    templateKey: 'walkthrough_request',
    replyTo: input.email,
    language: 'en',
  };
}
