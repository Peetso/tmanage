/**
 * R15-c (54-05 Slack + 54-06 Teams, Phase 0) — the channel notice renderer.
 *
 * Pure: an event in, a JSON body out. A notice carries only the event kind (as a fixed headline),
 * an optional title, the new state, an optional actor name and a deep link back to TManage — never
 * a description, a note or a comment, because a channel is usually wider than the project.
 *
 * - **Slack** has no RTL, so an Arabic line is wrapped in U+200F (RIGHT-TO-LEFT MARK) on both ends
 *   and kept on its own line in its own block (`renderSlack`). Text is mrkdwn with `&`, `<`, `>`
 *   escaped so a title cannot inject a mention or a link.
 * - **Teams** gets an Adaptive Card 1.4 inside the incoming-webhook message envelope, with
 *   `rtl: true` for Arabic (`renderTeams`).
 *
 * The copy table is fixed EN/AR here (a notice is posted by the worker, not rendered by the web
 * client, so it cannot read the web dictionaries).
 */

export const CHANNEL_LOCALES = ['en', 'ar'] as const;
export type ChannelLocale = (typeof CHANNEL_LOCALES)[number];

export const CHANNEL_TEST_KIND = 'integration.test';

const RLM = '‏';

/** The headline per event kind (54-03 catalogue kinds plus the test post). */
const HEADLINES: Readonly<Record<string, Readonly<Record<ChannelLocale, string>>>> = {
  'work.created': { en: 'New work item', ar: 'مهمة جديدة' },
  'work.updated': { en: 'Work item moved', ar: 'تم نقل مهمة' },
  'work.completed': { en: 'Work item done', ar: 'اكتملت مهمة' },
  'approval.decided': { en: 'Approval decided', ar: 'تم البت في موافقة' },
  'document.published': { en: 'Document published', ar: 'تم نشر مستند' },
  'client_request.created': { en: 'New client request', ar: 'طلب عميل جديد' },
  'client_request.transitioned': { en: 'Client request updated', ar: 'تم تحديث طلب عميل' },
  'meeting.scheduled': { en: 'Meeting scheduled', ar: 'تمت جدولة اجتماع' },
  [CHANNEL_TEST_KIND]: {
    en: 'TManage is connected to this channel',
    ar: 'تم ربط TManage بهذه القناة',
  },
};

const LABELS: Readonly<Record<ChannelLocale, Readonly<Record<'state' | 'by' | 'open', string>>>> = {
  en: { state: 'Status', by: 'By', open: 'Open in TManage' },
  ar: { state: 'الحالة', by: 'بواسطة', open: 'فتح في TManage' },
};

export interface ChannelNoticeEvent {
  /** A 54-03 webhook kind, or {@link CHANNEL_TEST_KIND}. */
  readonly kind: string;
  readonly title?: string | null;
  readonly state?: string | null;
  readonly actor?: string | null;
  /** An absolute https link back to TManage, or null when none can be built. */
  readonly link?: string | null;
}

export function isChannelLocale(value: unknown): value is ChannelLocale {
  return value === 'en' || value === 'ar';
}

/** The fixed headline for `kind` in `locale`; an unknown kind reads as a generic update. */
export function channelHeadline(kind: string, locale: ChannelLocale): string {
  return HEADLINES[kind]?.[locale] ?? (locale === 'ar' ? 'تحديث من TManage' : 'TManage update');
}

/** One Arabic line for Slack: RLM on both ends so the bidi run starts and ends right-to-left. */
export function rtlLine(text: string): string {
  return `${RLM}${text}${RLM}`;
}

function clip(text: string | null | undefined, max: number): string | null {
  if (typeof text !== 'string') return null;
  const flat = text.replace(/\s+/gu, ' ').trim();
  if (flat === '') return null;
  const chars = [...flat];
  return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : flat;
}

function escapeMrkdwn(text: string): string {
  return text.replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;');
}

function safeLink(link: string | null | undefined): string | null {
  if (typeof link !== 'string') return null;
  try {
    const url = new URL(link);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : null;
  } catch {
    return null;
  }
}

interface NoticeLines {
  readonly headline: string;
  readonly title: string | null;
  readonly state: string | null;
  readonly actor: string | null;
  readonly link: string | null;
}

function linesOf(event: ChannelNoticeEvent, locale: ChannelLocale): NoticeLines {
  return {
    headline: channelHeadline(event.kind, locale),
    title: clip(event.title, 200),
    state: clip(event.state, 60),
    actor: clip(event.actor, 120),
    link: safeLink(event.link),
  };
}

export interface SlackMessage {
  readonly text: string;
  readonly blocks: readonly Record<string, unknown>[];
}

/** A Slack incoming-webhook body: `text` (notification fallback) plus one section per line. */
export function renderSlack(event: ChannelNoticeEvent, locale: ChannelLocale): SlackMessage {
  const lines = linesOf(event, locale);
  const labels = LABELS[locale];
  const wrap = (text: string) => (locale === 'ar' ? rtlLine(text) : text);
  const rows: string[] = [`*${escapeMrkdwn(lines.headline)}*`];
  if (lines.title !== null) rows.push(escapeMrkdwn(lines.title));
  if (lines.state !== null) rows.push(`${labels.state}: ${escapeMrkdwn(lines.state)}`);
  if (lines.actor !== null) rows.push(`${labels.by}: ${escapeMrkdwn(lines.actor)}`);
  if (lines.link !== null) rows.push(`<${lines.link}|${labels.open}>`);
  const wrapped = rows.map(wrap);
  return {
    text: wrap(lines.title === null ? lines.headline : `${lines.headline}: ${lines.title}`),
    blocks: wrapped.map((text) => ({ type: 'section', text: { type: 'mrkdwn', text } })),
  };
}

/** A Teams incoming-webhook body: one Adaptive Card 1.4, `rtl: true` for Arabic. */
export function renderTeams(
  event: ChannelNoticeEvent,
  locale: ChannelLocale,
): Record<string, unknown> {
  const lines = linesOf(event, locale);
  const labels = LABELS[locale];
  const body: Record<string, unknown>[] = [
    { type: 'TextBlock', text: lines.headline, weight: 'Bolder', size: 'Medium', wrap: true },
  ];
  if (lines.title !== null) body.push({ type: 'TextBlock', text: lines.title, wrap: true });
  const facts: { title: string; value: string }[] = [];
  if (lines.state !== null) facts.push({ title: labels.state, value: lines.state });
  if (lines.actor !== null) facts.push({ title: labels.by, value: lines.actor });
  if (facts.length > 0) body.push({ type: 'FactSet', facts });
  const card: Record<string, unknown> = {
    $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
    type: 'AdaptiveCard',
    version: '1.4',
    ...(locale === 'ar' ? { rtl: true } : {}),
    body,
    ...(lines.link !== null
      ? { actions: [{ type: 'Action.OpenUrl', title: labels.open, url: lines.link }] }
      : {}),
  };
  return {
    type: 'message',
    attachments: [
      { contentType: 'application/vnd.microsoft.card.adaptive', contentUrl: null, content: card },
    ],
  };
}

/** The body for a link of `kind`. */
export function renderChannelNotice(
  kind: 'slack' | 'teams',
  event: ChannelNoticeEvent,
  locale: ChannelLocale,
): Record<string, unknown> {
  return kind === 'slack' ? { ...renderSlack(event, locale) } : renderTeams(event, locale);
}
