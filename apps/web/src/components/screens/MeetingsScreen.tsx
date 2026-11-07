'use client';

import { useState } from 'react';
import type { ReactNode } from 'react';
import Link from 'next/link';
import { AppShell } from '../shell/AppShell';
import { browserApiClient } from '../../lib/api/browser-client';
import type { ApiClient } from '../../lib/api/client';
import { appLocale } from '../../lib/i18n/app-locale';
import { activeIsEnglish } from '../../lib/i18n/compact-time';
import { useT } from '../../lib/i18n/use-t';
import { useTOr } from '../../lib/i18n/use-t-or';
import { useHydrated } from '../../lib/use-hydrated';
import { MeetingsHub } from '../meetings/MeetingsHub';
import { gmtOffset, type CalendarRange } from '../meetings/meeting-model';
import '../../styles/screens/calendar.css';

export interface MeetingsScreenProps {
  organizationSlug: string;
  organizationName: string;
  /** Preselect a project — how a project screen could hand off to its meetings. */
  initialProjectId?: string;
  /** `?view=day|week|month`; the week by default (approved Figma 415:19974). */
  initialRange?: CalendarRange;
  client?: ApiClient;
  /** Fixed "now" for stories and tests. */
  now?: Date;
}

/**
 * **CAL-01 / MTG-01 — Meetings (approved Figma 414:6710, 0237 slice C).**
 *
 * `/calendar` opens on **All meetings** — every meeting the person may read, across projects, in
 * a week (or day / month) window — never on "choose a project" (owner bug 1). The header carries
 * today's date and zone, a search box and "New meeting"; {@link MeetingsHub} draws the next
 * meeting with its Join button, the filters and the calendar itself.
 */
export function MeetingsScreen({
  organizationSlug,
  organizationName,
  initialProjectId,
  initialRange,
  client,
  now,
}: MeetingsScreenProps) {
  const api = client ?? browserApiClient();
  const t = useT();
  const [search, setSearch] = useState('');
  const [today] = useState(() => now ?? new Date());
  // The server's zone and clock are not the reader's: the date line is drawn on the client only,
  // or hydration fails with React #418 (2026-10-31 live test).
  const hydrated = useHydrated();
  const eyebrow =
    !hydrated && !now
      ? ''
      : `${new Intl.DateTimeFormat(dateLocale(), {
          weekday: 'long',
          day: 'numeric',
          month: 'short',
          year: 'numeric',
        })
          .format(today)
          .replace(',', '')} · ${zoneCity()}${gmtOffset(today)}`.toUpperCase();

  return (
    <AppShell
      organizationSlug={organizationSlug}
      organizationName={organizationName}
      activeNavigationId="calendar"
      title={t('MeetingsHub.title')}
      eyebrow={eyebrow}
      actions={
        <div className="tm-mtg-header-actions">
          <label className="tm-mtg-search">
            <span className="tm-mtg-search__icon" aria-hidden="true" />
            <span className="tm-visually-hidden">{t('MeetingsHub.searchLabel')}</span>
            <input
              type="search"
              value={search}
              placeholder={t('MeetingsHub.searchPlaceholder')}
              onChange={(event) => setSearch(event.target.value)}
            />
          </label>
          <Link
            href={`/${organizationSlug}/calendar/new`}
            className="tm-mtg-btn tm-mtg-btn--lime tm-mtg-btn--tall"
          >
            {t('MeetingsHub.newMeeting')}
          </Link>
        </div>
      }
    >
      <MeetingsHub
        organizationSlug={organizationSlug}
        client={api}
        search={search}
        {...(initialProjectId ? { initialProjectId } : {})}
        {...(initialRange ? { initialRange } : {})}
        {...(now ? { now } : {})}
      />
    </AppShell>
  );
}

/**
 * The locale the meeting dates are drawn in: the member's display locale (an Arabic member reads
 * an Arabic date line, 2026-11-02 functional test), with English kept in the approved en-GB shape
 * ("Tue 20 Oct") rather than en-US's "Tue, Oct 20".
 */
export function dateLocale(locale: string = appLocale()): string {
  return activeIsEnglish(locale) ? 'en-GB' : locale;
}

/** "CAIRO, " from the reader's zone (`Africa/Cairo`), or nothing for a bare offset zone. */
function zoneCity(): string {
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone ?? '';
  const city = zone.split('/').pop()?.replace(/_/g, ' ') ?? '';
  return city && city !== 'UTC' ? `${city}, ` : '';
}

/** A meeting as the track draws it — the subset of the API row it reads. */
export interface TrackMeeting {
  readonly id: string;
  readonly title: string;
  readonly startsAt: string;
}

/**
 * CAL-02's track: one black capsule of real meetings in time order — finished ones muted with a
 * tick, the next one in lime, later ones outlined — and an arrow out to the agenda. It shows at
 * most six slots around the next meeting; the sheet below holds the full list and its links.
 */
export function MeetingTrack({
  organizationSlug,
  label,
  meetings,
  nextId,
  now,
}: {
  organizationSlug: string;
  label: string;
  meetings: readonly TrackMeeting[];
  nextId: string | null;
  now: number;
}) {
  const t = useT();
  const ordered = [...meetings].sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt));
  const nextIndex = nextId === null ? ordered.length : ordered.findIndex((m) => m.id === nextId);
  const start = Math.max(0, Math.min(nextIndex - 2, ordered.length - 6));
  const slots = ordered.slice(start, start + 6);
  const next = ordered.find((m) => m.id === nextId);
  const today = new Date(now);
  return (
    <section className="tm-cal-track-block" aria-labelledby="tm-cal-track-label">
      <p className="tm-cal-subnav">
        <span id="tm-cal-track-label" className="tm-cal-subnav__label">
          {label}
        </span>
        <span>
          {meetings.length}{' '}
          {meetings.length === 1
            ? t('MeetingsScreen.meetingSingular')
            : t('MeetingsScreen.meetingPlural')}
          {next
            ? ` · ${t('MeetingsScreen.nextLabel')} ${whenLabel(next.startsAt)}`
            : ` · ${t('MeetingsScreen.noneAhead')}`}
        </span>
      </p>
      <ol className="tm-cal-track" aria-labelledby="tm-cal-track-label">
        <li className="tm-cal-track__lead">
          <span className="tm-cal-track__day" aria-hidden="true">
            {String(today.getDate()).padStart(2, '0')}
          </span>
          <span>{t('MeetingsScreen.today')}</span>
        </li>
        {slots.map((meeting) => {
          const state = meetingState(meeting.startsAt, meeting.id === nextId, now);
          return (
            <li key={meeting.id} className="tm-cal-track__item">
              {/* Not a link: the sheet below links each meeting, and a second link with the same
                  name would make "the link called <title>" ambiguous. */}
              <span className="tm-cal-track__slot" data-state={state}>
                <span className="tm-cal-track__time">
                  {state === 'next' ? t('MeetingsScreen.nextSlotPrefix') : ''}
                  {whenLabel(meeting.startsAt)}
                </span>
                <span className="tm-cal-track__label">{meeting.title}</span>
                {state === 'done' ? (
                  <>
                    <span className="tm-cal-track__tick" aria-hidden="true">
                      ✓
                    </span>
                    <span className="tm-visually-hidden">{t('MeetingsScreen.doneHidden')}</span>
                  </>
                ) : null}
              </span>
            </li>
          );
        })}
        <li className="tm-cal-track__end">
          <Link
            href={`/${organizationSlug}/calendar/agenda`}
            className="tm-cal-track__out"
            aria-label={t('MeetingsScreen.openAgendaAria')}
          >
            ↗
          </Link>
        </li>
      </ol>
    </section>
  );
}

/** Which calendar view is current — the header switch marks it with `aria-current`. */
export type CalendarView = 'meetings' | 'week' | 'month' | 'agenda' | 'none';

/**
 * CAL-02's header end: the "Meetings · Week · Month · Agenda" switch and the ink "Protect focus"
 * capsule. Each segment is a link to a real route, so the switch is plain navigation.
 */
export function CalendarHeaderActions({
  organizationSlug,
  current,
}: {
  organizationSlug: string;
  current: CalendarView;
}) {
  const t = useT();
  const base = `/${organizationSlug}/calendar`;
  const views: readonly { id: CalendarView; label: string; href: string }[] = [
    { id: 'meetings', label: t('MeetingsScreen.viewMeetings'), href: base },
    { id: 'week', label: t('MeetingsScreen.viewWeek'), href: `${base}/grid?range=week` },
    { id: 'month', label: t('MeetingsScreen.viewMonth'), href: `${base}/grid?range=month` },
    { id: 'agenda', label: t('MeetingsScreen.viewAgenda'), href: `${base}/agenda` },
  ];
  return (
    <div className="tm-cal-header-actions">
      <nav className="tm-cal-views" aria-label={t('MeetingsScreen.viewsAria')}>
        {views.map((view) => (
          <Link
            key={view.id}
            href={view.href}
            className="tm-cal-views__item"
            {...(view.id === current ? { 'aria-current': 'page' as const } : {})}
          >
            {view.label}
          </Link>
        ))}
      </nav>
      <Link href={`${base}/focus-blocks`} className="tm-cal-btn tm-cal-btn--ink tm-cal-btn--header">
        {t('MeetingsScreen.protectFocus')}
      </Link>
    </div>
  );
}

/** The quiet line under the header that reaches the calendar's other surfaces. */
export function CalendarSubnav({
  organizationSlug,
  current,
}: {
  organizationSlug: string;
  current?: 'series' | 'agenda-templates' | 'focus-blocks';
}) {
  const t = useT();
  const base = `/${organizationSlug}/calendar`;
  const links: readonly { id: string; label: string; href: string }[] = [
    { id: 'series', label: t('MeetingsScreen.subRecurring'), href: `${base}/series` },
    {
      id: 'agenda-templates',
      label: t('MeetingsScreen.subAgendaTemplates'),
      href: `${base}/agenda-templates`,
    },
    { id: 'focus-blocks', label: t('MeetingsScreen.subFocusBlocks'), href: `${base}/focus-blocks` },
  ];
  return (
    <nav className="tm-cal-subnav" aria-label={t('MeetingsScreen.subnavAria')}>
      <span className="tm-cal-subnav__label">{t('MeetingsScreen.subnavLabel')}</span>
      {links.map((link) => (
        <Link
          key={link.id}
          href={link.href}
          {...(link.id === current ? { 'aria-current': 'page' as const } : {})}
        >
          {link.label}
        </Link>
      ))}
    </nav>
  );
}

/** A meeting's own pages, switched like the calendar views (MTG-01 / MTG-03 / CAL-03). */
export type MeetingPage =
  'overview' | 'notes' | 'attendees' | 'rsvp' | 'time-poll' | 'action-items';

export function MeetingHeaderActions({
  organizationSlug,
  meetingId,
  current,
  children,
}: {
  organizationSlug: string;
  meetingId: string;
  current: MeetingPage;
  /** Trailing controls, e.g. the ICS export capsule. */
  children?: ReactNode;
}) {
  const t = useT();
  const tOr = useTOr();
  const base = `/${organizationSlug}/calendar/meetings/${encodeURIComponent(meetingId)}`;
  const views: readonly { id: MeetingPage; label: string; href: string }[] = [
    // A5: the meeting's detail is its Overview; the notes moved to their own `/notes` page.
    { id: 'overview', label: tOr('MeetingsScreen.mtgOverview', 'Overview'), href: base },
    { id: 'notes', label: t('MeetingsScreen.mtgNotes'), href: `${base}/notes` },
    { id: 'attendees', label: t('MeetingsScreen.mtgAttendees'), href: `${base}/attendees` },
    { id: 'rsvp', label: t('MeetingsScreen.mtgRsvp'), href: `${base}/rsvp` },
    { id: 'time-poll', label: t('MeetingsScreen.mtgTimePoll'), href: `${base}/time-poll` },
    { id: 'action-items', label: t('MeetingsScreen.mtgActions'), href: `${base}/action-items` },
  ];
  return (
    <div className="tm-cal-header-actions">
      {meetingId !== '' ? (
        <nav className="tm-cal-views" aria-label={t('MeetingsScreen.mtgNavAria')}>
          {views.map((view) => (
            <Link
              key={view.id}
              href={view.href}
              // Six tabs prefetching at once drew 503s from the host (2026-10-31 live test).
              prefetch={false}
              className="tm-cal-views__item"
              {...(view.id === current ? { 'aria-current': 'page' as const } : {})}
            >
              {view.label}
            </Link>
          ))}
        </nav>
      ) : null}
      {children}
    </div>
  );
}

/** The line back to the calendar above a meeting's page. */
export function MeetingBackLink({ organizationSlug }: { organizationSlug: string }) {
  const t = useT();
  return (
    <nav className="tm-cal-subnav" aria-label={t('MeetingsScreen.backAria')}>
      <span className="tm-cal-subnav__label">{t('MeetingsScreen.backLabel')}</span>
      <Link href={`/${organizationSlug}/calendar`}>{t('MeetingsScreen.backAllMeetings')}</Link>
      <Link href={`/${organizationSlug}/calendar/agenda`}>{t('MeetingsScreen.backAgenda')}</Link>
    </nav>
  );
}

/** "Ada Lovelace" → "AL": the initials an avatar orb carries. */
export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const first = parts[0]?.[0] ?? '';
  const last = parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? '') : '';
  return (first + last).toUpperCase() || '·';
}

/** "Tue 20 Oct · 12:00" — the mono time cell, in the reader's zone. */
export function whenLabel(iso: string): string {
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return iso;
  const day = new Intl.DateTimeFormat(dateLocale(), {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
  }).format(parsed);
  return `${day.replace(',', '')} · ${clockLabel(iso)}`;
}

/** "12:00" — a 24-hour clock time in the reader's zone. */
export function clockLabel(iso: string): string {
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return iso;
  return new Intl.DateTimeFormat(dateLocale(), {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(parsed);
}

function meetingState(startsAt: string, isNext: boolean, now: number): 'done' | 'next' | 'later' {
  if (isNext) return 'next';
  const at = Date.parse(startsAt);
  return !Number.isNaN(at) && at < now ? 'done' : 'later';
}
