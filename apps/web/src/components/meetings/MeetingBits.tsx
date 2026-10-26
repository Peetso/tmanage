'use client';

import type { MessageKey } from '../../lib/i18n/t';
import type { MeetingOverviewView } from '../../lib/api/meetings';
import { useT } from '../../lib/i18n/use-t';
import { fillTemplate } from '../../lib/ai-approval-presentation';
import { answerCounts } from './meeting-model';

type Translate = (key: MessageKey) => string;

/** "Ada Lovelace" → "AL"; an email guest → its first letter. */
export function initialsOf(name: string | null, email: string | null = null): string {
  const source = (name ?? '').trim();
  if (source === '') return (email?.[0] ?? '·').toUpperCase();
  const parts = source.split(/\s+/).filter(Boolean);
  const first = parts[0]?.[0] ?? '';
  const last = parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? '') : '';
  return (first + last).toUpperCase();
}

/** Provider names are plain text (no logos): "Google Meet", "Microsoft Teams", "No video call". */
export function conferenceName(t: Translate, conference: string | undefined): string {
  if (conference === 'google_meet') return 'Google Meet';
  if (conference === 'teams') return 'Microsoft Teams';
  return t('MeetingsHub.noVideo');
}

/** The month chip's short form: "Meet" / "Teams" / nothing. */
export function conferenceShort(conference: string | undefined): string | null {
  if (conference === 'google_meet') return 'Meet';
  if (conference === 'teams') return 'Teams';
  return null;
}

/** "Google Calendar" / "Microsoft Outlook" — the calendar a meeting lives in. */
export function calendarName(provider: string | undefined): string {
  return provider === 'microsoft' ? 'Microsoft Outlook' : 'Google Calendar';
}

/** "Join Google Meet" / "Join Microsoft Teams". */
export function joinLabel(t: Translate, conference: string | undefined): string {
  return fillTemplate(t('MeetingsHub.joinNamed'), {
    name: conference === 'teams' ? 'Microsoft Teams' : 'Google Meet',
  });
}

/** "4 yes · 1 maybe · 1 no · 2 awaiting" — zero parts left out. */
export function answersLine(t: Translate, overview: MeetingOverviewView | undefined): string {
  if (!overview) return '';
  const counts = answerCounts(overview.people);
  const parts: string[] = [];
  if (counts.yes) parts.push(fillTemplate(t('MeetingsHub.countYes'), { n: String(counts.yes) }));
  if (counts.maybe) {
    parts.push(fillTemplate(t('MeetingsHub.countMaybe'), { n: String(counts.maybe) }));
  }
  if (counts.no) parts.push(fillTemplate(t('MeetingsHub.countNo'), { n: String(counts.no) }));
  if (counts.awaiting) {
    parts.push(fillTemplate(t('MeetingsHub.countAwaiting'), { n: String(counts.awaiting) }));
  }
  return parts.join(' · ');
}

/** "6 of 7 said yes" / "No answers yet" — the week block's last line. */
export function saidYesLine(t: Translate, overview: MeetingOverviewView | undefined): string {
  if (!overview) return '';
  const counts = answerCounts(overview.people);
  if (counts.yes === 0) return t('MeetingsHub.noAnswersYet');
  return fillTemplate(t('MeetingsHub.saidYes'), {
    n: String(counts.yes),
    total: String(counts.total),
  });
}

/** Up to four overlapping initials orbs. */
export function AvatarStack({
  people,
  size = 'md',
}: {
  people: MeetingOverviewView['people'];
  size?: 'sm' | 'md';
}) {
  const shown = people.slice(0, 4);
  if (shown.length === 0) return null;
  return (
    <span className={`tm-mtg-avatars tm-mtg-avatars--${size}`} aria-hidden="true">
      {shown.map((person) => (
        <span key={person.id} className="tm-mtg-avatar" data-kind={person.kind}>
          {initialsOf(person.displayName, person.email)}
        </span>
      ))}
    </span>
  );
}

/** The Join button: a link to Meet/Teams in a new tab (live calls cannot be embedded). */
export function JoinLink({
  overview,
  tone = 'lime',
}: {
  overview: MeetingOverviewView | undefined;
  tone?: 'lime' | 'outline' | 'ink';
}) {
  const t = useT();
  const url = overview?.external?.joinUrl;
  if (!overview || !url) return null;
  return (
    <a
      className={`tm-mtg-btn tm-mtg-btn--${tone}`}
      href={url}
      target="_blank"
      rel="noopener noreferrer"
    >
      {joinLabel(t, overview.conference)}
      <span className="tm-visually-hidden"> {t('MeetingsHub.opensNewTab')}</span>
    </a>
  );
}
