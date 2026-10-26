'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { InlineAlert, LoadingRegion, Skeleton } from '@tmanage/ui';
import type { ApiClient } from '../../lib/api/client';
import { ApiRequestError } from '../../lib/api/errors';
import {
  listAllProjects,
  listMeetingsInWindow,
  syncMeeting,
  type MeetingOverviewView,
  type MeetingView,
} from '../../lib/api/meetings';
import { setMeetingRsvp, type MeetingRsvpResponse } from '../../lib/api/meeting-rsvp';
import { startCalendarConnect } from '../../lib/api/calendar-connections';
import { fillTemplate } from '../../lib/ai-approval-presentation';
import { useT } from '../../lib/i18n/use-t';
import {
  addDays,
  blockPosition,
  dayKey,
  daysOf,
  gridHours,
  startOfDay,
  stepAnchor,
  timeRange,
  clock,
  windowOf,
  type CalendarRange,
} from './meeting-model';
import {
  AvatarStack,
  JoinLink,
  answersLine,
  calendarName,
  conferenceName,
  conferenceShort,
  saidYesLine,
} from './MeetingBits';
import {
  useCalendarAccounts,
  useMeetingOverviews,
  useMyUserId,
  type CalendarAccount,
} from './use-meetings-data';
import './meetings.css';

export interface MeetingsHubProps {
  organizationSlug: string;
  client: ApiClient;
  /** The header's search box. */
  search: string;
  initialProjectId?: string;
  initialRange?: CalendarRange;
  /** Fixed "now" for stories and tests; the clock otherwise. */
  now?: Date;
}

const HOUR_HEIGHT = 96;

/**
 * **Meetings (approved Figma 414:6710).** `/calendar` opens on **All meetings**: every meeting the
 * person may read, across projects, in a day, week or month window (`GET …/meetings` without a
 * project — owner bug 1). Above it the next meeting with its Join button (Meet/Teams open in a
 * new tab); the filter row narrows by Mine / project / upcoming–past. A provider that failed shows
 * a banner with "Try again"; with no calendar connected and nothing planned, the connect cards.
 */
export function MeetingsHub({
  organizationSlug,
  client: api,
  search,
  initialProjectId,
  initialRange = 'week',
  now: fixedNow,
}: MeetingsHubProps) {
  const t = useT();
  const queries = useQueryClient();
  const now = useMemo(() => fixedNow ?? new Date(), [fixedNow]);
  const [range, setRange] = useState<CalendarRange>(initialRange);
  const [anchor, setAnchor] = useState<Date>(() => startOfDay(now));
  const [scope, setScope] = useState<'all' | 'mine'>('all');
  const [projectId, setProjectId] = useState(initialProjectId ?? '');
  const [when, setWhen] = useState<'upcoming' | 'past'>('upcoming');

  const span = windowOf(range, anchor);
  const projects = useQuery({
    queryKey: ['projects', organizationSlug],
    queryFn: () => listAllProjects(api, organizationSlug),
  });
  const meetings = useQuery({
    queryKey: ['meetings', organizationSlug, 'window', span.from, span.to],
    queryFn: () => listMeetingsInWindow(api, organizationSlug, span),
  });
  const upcomingWindow = useMemo(
    () => ({ from: startOfDay(now).toISOString(), to: addDays(now, 30).toISOString() }),
    [now],
  );
  const upcoming = useQuery({
    queryKey: ['meetings', organizationSlug, 'window', upcomingWindow.from, upcomingWindow.to],
    queryFn: () => listMeetingsInWindow(api, organizationSlug, upcomingWindow),
  });

  const myUserId = useMyUserId(api, organizationSlug);
  const { accounts, loaded: accountsLoaded } = useCalendarAccounts(api, organizationSlug);
  const projectNames = useMemo(
    () => new Map((projects.data ?? []).map((p) => [p.id, p.name] as const)),
    [projects.data],
  );

  const nextMeeting = useMemo(
    () =>
      [...(upcoming.data ?? [])]
        .filter((m) => endOf(m) > now.getTime())
        .sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt))[0],
    [upcoming.data, now],
  );

  const all = meetings.data ?? [];
  const overviews = useMeetingOverviews(api, organizationSlug, [
    ...(nextMeeting ? [nextMeeting.id] : []),
    ...all.map((m) => m.id),
    ...(upcoming.data ?? []).map((m) => m.id),
  ]);

  const isMine = (meeting: MeetingView): boolean =>
    myUserId !== null &&
    (meeting.createdByUserId === myUserId ||
      (overviews.get(meeting.id)?.people ?? []).some((p) => p.userId === myUserId));

  const needle = search.trim().toLowerCase();
  const baseRows = all.filter(
    (m) =>
      (projectId === '' || m.projectId === projectId) &&
      (needle === '' || m.title.toLowerCase().includes(needle)),
  );
  const rows = baseRows.filter(
    (m) =>
      (scope === 'all' || isMine(m)) &&
      (when === 'upcoming' ? endOf(m) >= startOfDay(now).getTime() : endOf(m) < now.getTime()),
  );
  const mineCount = baseRows.filter(isMine).length;

  const needsAnswer = useMemo(
    () =>
      myUserId === null
        ? []
        : (upcoming.data ?? []).filter((m) => {
            const me = overviews
              .get(m.id)
              ?.people.find((p) => p.userId === myUserId && !p.organizer);
            return me?.rsvp === 'invited' && Date.parse(m.startsAt) > now.getTime();
          }),
    [upcoming.data, overviews, myUserId, now],
  );

  const retry = useMutation({
    mutationFn: (meetingId: string) => syncMeeting(api, organizationSlug, meetingId),
    onSuccess: (overview) => {
      queries.setQueryData(['meeting-overview', organizationSlug, overview.meeting.id], overview);
    },
  });
  const reconnect = useMutation({
    mutationFn: (provider: 'google' | 'microsoft') =>
      startCalendarConnect(api, organizationSlug, provider),
    onSuccess: ({ url }) => {
      globalThis.location.assign(url);
    },
  });

  const failing = [...overviews.values()].filter(
    (o) => o.external?.syncStatus === 'error' && o.cancelledAt === null,
  );
  const brokenAccounts = accounts.filter((a) => a.status === 'error');
  const noCalendar = accountsLoaded && !accounts.some((a) => a.status !== 'not_connected');
  const showEmpty =
    noCalendar &&
    accounts.length > 0 &&
    meetings.isSuccess &&
    upcoming.isSuccess &&
    all.length === 0 &&
    (upcoming.data ?? []).length === 0;

  if (showEmpty) {
    return (
      <div className="tm-mtg">
        <EmptyConnect organizationSlug={organizationSlug} accounts={accounts} api={api} />
      </div>
    );
  }

  const nextOverview = nextMeeting ? overviews.get(nextMeeting.id) : undefined;
  const nextId = nextMeeting?.id ?? null;

  return (
    <div className="tm-mtg">
      {failing.slice(0, 2).map((overview) => (
        <div key={overview.meeting.id} className="tm-mtg-banner" data-tone="danger" role="status">
          <p>
            <span aria-hidden="true">×</span>{' '}
            {fillTemplate(t('MeetingsHub.syncFailed'), {
              provider: calendarName(overview.external?.provider),
              title: overview.meeting.title,
            })}
          </p>
          <button
            type="button"
            className="tm-mtg-btn tm-mtg-btn--outline"
            onClick={() => retry.mutate(overview.meeting.id)}
            disabled={retry.isPending}
          >
            {t('MeetingsHub.tryAgain')}
          </button>
        </div>
      ))}
      {brokenAccounts.map((account) => (
        <div key={account.provider} className="tm-mtg-banner" data-tone="warning" role="status">
          <p>
            <span aria-hidden="true">!</span>{' '}
            {fillTemplate(t('MeetingsHub.needsSignIn'), {
              provider: calendarName(account.provider),
            })}
          </p>
          <button
            type="button"
            className="tm-mtg-btn tm-mtg-btn--ink"
            onClick={() => reconnect.mutate(account.provider)}
            disabled={reconnect.isPending}
          >
            {fillTemplate(t('MeetingsHub.reconnectNamed'), {
              provider: account.provider === 'microsoft' ? 'Outlook' : 'Google',
            })}
          </button>
        </div>
      ))}

      {nextMeeting && failing.length === 0 && brokenAccounts.length === 0 ? (
        <section className="tm-mtg-next" aria-labelledby="tm-mtg-next-title">
          <div className="tm-mtg-next__text">
            <p className="tm-mtg-mono tm-mtg-next__eyebrow">
              {[
                t('MeetingsHub.upNext'),
                timeRange(nextMeeting.startsAt, nextMeeting.endsAt),
                nextOverview && nextOverview.conference !== 'none'
                  ? conferenceName(t, nextOverview.conference)
                  : null,
              ]
                .filter(Boolean)
                .join(' · ')
                .toUpperCase()}
            </p>
            <h2 id="tm-mtg-next-title" className="tm-mtg-next__title">
              <Link href={meetingHref(organizationSlug, nextMeeting.id)}>{nextMeeting.title}</Link>
            </h2>
            <p className="tm-mtg-next__meta">
              <span>{projectNames.get(nextMeeting.projectId) ?? ''}</span>
              {nextOverview ? <span> · {answersLine(t, nextOverview)}</span> : null}
            </p>
          </div>
          <div className="tm-mtg-next__end">
            {nextOverview ? <AvatarStack people={nextOverview.people} /> : null}
            <JoinLink overview={nextOverview} />
          </div>
        </section>
      ) : null}

      <div className="tm-mtg-filters">
        <div className="tm-mtg-filters__group">
          <button
            type="button"
            className="tm-mtg-chip"
            aria-pressed={scope === 'all'}
            onClick={() => setScope('all')}
          >
            {t('MeetingsHub.allMeetings')}
            <span className="tm-mtg-chip__count">{baseRows.length}</span>
          </button>
          {myUserId !== null ? (
            <button
              type="button"
              className="tm-mtg-chip"
              aria-pressed={scope === 'mine'}
              onClick={() => setScope('mine')}
            >
              {t('MeetingsHub.mine')}
              <span className="tm-mtg-chip__count">{mineCount}</span>
            </button>
          ) : null}
          <label className="tm-mtg-select">
            <span className="tm-visually-hidden">{t('MeetingsHub.projectLabel')}</span>
            <select value={projectId} onChange={(event) => setProjectId(event.target.value)}>
              <option value="">{t('MeetingsHub.allProjects')}</option>
              {(projects.data ?? []).map((project) => (
                <option key={project.id} value={project.id}>
                  {fillTemplate(t('MeetingsHub.projectNamed'), { name: project.name })}
                </option>
              ))}
            </select>
          </label>
          <div className="tm-mtg-seg" role="group" aria-label={t('MeetingsHub.whenAria')}>
            <button
              type="button"
              aria-pressed={when === 'upcoming'}
              onClick={() => setWhen('upcoming')}
            >
              {t('MeetingsHub.upcoming')}
            </button>
            <button type="button" aria-pressed={when === 'past'} onClick={() => setWhen('past')}>
              {t('MeetingsHub.past')}
            </button>
          </div>
        </div>
        <div className="tm-mtg-filters__group">
          <button
            type="button"
            className="tm-mtg-btn tm-mtg-btn--outline"
            onClick={() => setAnchor(startOfDay(now))}
          >
            {t('MeetingsHub.today')}
          </button>
          <button
            type="button"
            className="tm-mtg-step"
            aria-label={t('MeetingsHub.previous')}
            onClick={() => setAnchor(stepAnchor(range, anchor, -1))}
          >
            <span aria-hidden="true">‹</span>
          </button>
          <p className="tm-mtg-range" aria-live="polite">
            {rangeLabel(range, anchor)}
          </p>
          <button
            type="button"
            className="tm-mtg-step"
            aria-label={t('MeetingsHub.next')}
            onClick={() => setAnchor(stepAnchor(range, anchor, 1))}
          >
            <span aria-hidden="true">›</span>
          </button>
          <div className="tm-mtg-seg" role="group" aria-label={t('MeetingsHub.rangeAria')}>
            {(['day', 'week', 'month'] as const).map((id) => (
              <button
                key={id}
                type="button"
                aria-pressed={range === id}
                onClick={() => setRange(id)}
              >
                {t(RANGE_KEYS[id])}
              </button>
            ))}
          </div>
        </div>
      </div>

      {meetings.isError ? (
        <InlineAlert tone="danger" title={t('MeetingsHub.loadError')} live>
          {meetings.error instanceof ApiRequestError
            ? meetings.error.message
            : t('MeetingsHub.noAnswer')}
        </InlineAlert>
      ) : null}
      {meetings.isPending ? (
        <LoadingRegion label={t('MeetingsHub.loading')}>
          <Skeleton height="var(--row)" />
          <Skeleton height="var(--row)" />
        </LoadingRegion>
      ) : null}

      {meetings.isSuccess && range === 'week' ? (
        <WeekGrid
          organizationSlug={organizationSlug}
          days={daysOf('week', anchor)}
          meetings={rows}
          overviews={overviews}
          projectNames={projectNames}
          nextId={nextId}
          highlight={new Set(needsAnswer.map((m) => m.id))}
          now={now}
        />
      ) : null}
      {meetings.isSuccess && range === 'month' ? (
        <MonthGrid
          organizationSlug={organizationSlug}
          anchor={anchor}
          meetings={rows}
          overviews={overviews}
          nextId={nextId}
          now={now}
        />
      ) : null}
      {meetings.isSuccess && range === 'day' ? (
        <div className="tm-mtg-day">
          <DayList
            organizationSlug={organizationSlug}
            meetings={rows}
            overviews={overviews}
            projectNames={projectNames}
            nextId={nextId}
            now={now}
            onRetry={(id) => retry.mutate(id)}
          />
          <aside className="tm-mtg-day__side">
            {needsAnswer.length > 0 ? (
              <Invitations
                api={api}
                organizationSlug={organizationSlug}
                meetings={needsAnswer}
                overviews={overviews}
              />
            ) : null}
            <YourCalendars organizationSlug={organizationSlug} accounts={accounts} now={now} />
          </aside>
        </div>
      ) : null}
    </div>
  );
}

const RANGE_KEYS = {
  day: 'MeetingsHub.day',
  week: 'MeetingsHub.week',
  month: 'MeetingsHub.month',
} as const;

function endOf(meeting: MeetingView): number {
  return meeting.endsAt ? Date.parse(meeting.endsAt) : Date.parse(meeting.startsAt) + 3_600_000;
}

function meetingHref(organizationSlug: string, meetingId: string): string {
  return `/${organizationSlug}/calendar/meetings/${encodeURIComponent(meetingId)}`;
}

function rangeLabel(range: CalendarRange, anchor: Date): string {
  if (range === 'day') {
    return new Intl.DateTimeFormat('en-GB', {
      weekday: 'long',
      day: 'numeric',
      month: 'long',
      year: 'numeric',
    })
      .format(anchor)
      .replace(',', '');
  }
  if (range === 'month') {
    return new Intl.DateTimeFormat('en-GB', { month: 'long', year: 'numeric' }).format(anchor);
  }
  const days = daysOf('week', anchor);
  const first = days[0] ?? anchor;
  const last = days[6] ?? anchor;
  const short = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short' });
  return `${short.format(first)} – ${short.format(last)} ${last.getFullYear()}`;
}

function weekdayShort(date: Date): string {
  return new Intl.DateTimeFormat('en-GB', { weekday: 'short' }).format(date).toUpperCase();
}

interface GridProps {
  organizationSlug: string;
  meetings: readonly MeetingView[];
  overviews: ReadonlyMap<string, MeetingOverviewView>;
  nextId: string | null;
  now: Date;
}

/** Week (415:19974): seven day columns, an all-day row, hour rows, the red now-line. */
function WeekGrid({
  organizationSlug,
  days,
  meetings,
  overviews,
  projectNames,
  nextId,
  highlight,
  now,
}: GridProps & {
  days: readonly Date[];
  projectNames: ReadonlyMap<string, string>;
  highlight: ReadonlySet<string>;
}) {
  const t = useT();
  const timed = meetings.filter((m) => !overviews.get(m.id)?.allDay);
  const allDay = meetings.filter((m) => overviews.get(m.id)?.allDay);
  const hours = gridHours(timed);
  const hourList = Array.from({ length: hours.last - hours.first }, (_, i) => hours.first + i);
  const todayKey = dayKey(now);
  const nowTop = ((now.getHours() - hours.first) * 60 + now.getMinutes()) * (HOUR_HEIGHT / 60);
  return (
    <section className="tm-mtg-week" aria-label={t('MeetingsHub.weekAria')}>
      <div className="tm-mtg-week__head">
        <span />
        {days.map((day) => (
          <span key={dayKey(day)} className="tm-mtg-week__dayname">
            <span className="tm-mtg-mono" data-today={dayKey(day) === todayKey || undefined}>
              {weekdayShort(day)} {day.getDate()}
            </span>
          </span>
        ))}
      </div>
      <div className="tm-mtg-week__allday">
        <span className="tm-mtg-mono tm-mtg-week__label">{t('MeetingsHub.allDay')}</span>
        {days.map((day) => (
          <span key={dayKey(day)} className="tm-mtg-week__allday-cell">
            {allDay
              .filter((m) => dayKey(new Date(m.startsAt)) === dayKey(day))
              .map((m) => (
                <Link
                  key={m.id}
                  className="tm-mtg-allday"
                  href={meetingHref(organizationSlug, m.id)}
                >
                  {m.title}
                </Link>
              ))}
          </span>
        ))}
      </div>
      <div className="tm-mtg-week__body" style={{ blockSize: hourList.length * HOUR_HEIGHT }}>
        <div className="tm-mtg-week__hours" aria-hidden="true">
          {hourList.map((hour) => (
            <span key={hour} className="tm-mtg-mono" style={{ blockSize: HOUR_HEIGHT }}>
              {String(hour).padStart(2, '0')}:00
            </span>
          ))}
        </div>
        {days.map((day) => {
          const key = dayKey(day);
          const weekend = day.getDay() === 0 || day.getDay() === 6;
          return (
            <div key={key} className="tm-mtg-week__col" data-weekend={weekend || undefined}>
              {hourList.map((hour) => (
                <span key={hour} className="tm-mtg-week__slot" style={{ blockSize: HOUR_HEIGHT }} />
              ))}
              {key === todayKey && nowTop >= 0 && nowTop <= hourList.length * HOUR_HEIGHT ? (
                <span className="tm-mtg-week__now" style={{ insetBlockStart: nowTop }} />
              ) : null}
              {timed
                .filter((m) => dayKey(new Date(m.startsAt)) === key)
                .map((m) => {
                  const overview = overviews.get(m.id);
                  const place = blockPosition(m.startsAt, m.endsAt, hours.first, HOUR_HEIGHT);
                  const tone = m.id === nextId ? 'next' : highlight.has(m.id) ? 'lime' : 'plain';
                  return (
                    <Link
                      key={m.id}
                      href={meetingHref(organizationSlug, m.id)}
                      className="tm-mtg-block"
                      data-tone={tone}
                      style={{ insetBlockStart: place.top + 2, blockSize: place.height }}
                    >
                      <span className="tm-mtg-mono tm-mtg-block__time">
                        {timeRange(m.startsAt, m.endsAt)}
                      </span>
                      <span className="tm-mtg-block__title">{m.title}</span>
                      {overview ? (
                        <span className="tm-mtg-block__call">
                          {conferenceName(t, overview.conference)}
                        </span>
                      ) : null}
                      <span className="tm-mtg-block__sub">{projectNames.get(m.projectId)}</span>
                      <span className="tm-mtg-block__sub">{saidYesLine(t, overview)}</span>
                    </Link>
                  );
                })}
            </div>
          );
        })}
      </div>
    </section>
  );
}

/** Month (415:20283): whole weeks, a chip per meeting, today's date in a lime pill. */
function MonthGrid({
  organizationSlug,
  anchor,
  meetings,
  overviews,
  nextId,
  now,
}: GridProps & { anchor: Date }) {
  const t = useT();
  const days = daysOf('month', anchor);
  const todayKey = dayKey(now);
  const byDay = new Map<string, MeetingView[]>();
  for (const m of [...meetings].sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt))) {
    const key = dayKey(new Date(m.startsAt));
    byDay.set(key, [...(byDay.get(key) ?? []), m]);
  }
  return (
    <section className="tm-mtg-month" aria-label={t('MeetingsHub.monthAria')}>
      <div className="tm-mtg-month__head" aria-hidden="true">
        {days.slice(0, 7).map((day) => (
          <span key={dayKey(day)} className="tm-mtg-mono">
            {weekdayShort(day)}
          </span>
        ))}
      </div>
      <div className="tm-mtg-month__grid">
        {days.map((day) => {
          const key = dayKey(day);
          const weekend = day.getDay() === 0 || day.getDay() === 6;
          const outside = day.getMonth() !== anchor.getMonth();
          return (
            <div
              key={key}
              className="tm-mtg-month__cell"
              data-weekend={weekend || undefined}
              data-outside={outside || undefined}
            >
              <span className="tm-mtg-month__date" data-today={key === todayKey || undefined}>
                {day.getDate()}
              </span>
              {(byDay.get(key) ?? []).map((m) => {
                const overview = overviews.get(m.id);
                const short = conferenceShort(overview?.conference);
                const past = Date.parse(m.endsAt ?? m.startsAt) < now.getTime();
                const tone =
                  m.id === nextId ? 'next' : overview?.allDay ? 'allday' : past ? 'past' : 'lime';
                return (
                  <Link
                    key={m.id}
                    href={meetingHref(organizationSlug, m.id)}
                    className="tm-mtg-chiplink"
                    data-tone={tone}
                  >
                    {overview?.allDay ? '' : `${clock(m.startsAt)} `}
                    {m.title}
                    {short ? ` · ${short}` : ''}
                  </Link>
                );
              })}
            </div>
          );
        })}
      </div>
    </section>
  );
}

/** Day (415:21498): earlier today, next, later — cards with people, answers and Join. */
function DayList({
  organizationSlug,
  meetings,
  overviews,
  projectNames,
  nextId,
  now,
  onRetry,
}: GridProps & { projectNames: ReadonlyMap<string, string>; onRetry: (id: string) => void }) {
  const t = useT();
  const sorted = [...meetings].sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt));
  const earlier = sorted.filter((m) => endOf(m) < now.getTime());
  const later = sorted.filter((m) => endOf(m) >= now.getTime());
  if (sorted.length === 0) {
    return (
      <div className="tm-mtg-day__list">
        <p className="tm-mtg-quiet">{t('MeetingsHub.nothingThisDay')}</p>
      </div>
    );
  }
  const card = (m: MeetingView, state: 'ended' | 'next' | 'later') => {
    const overview = overviews.get(m.id);
    const failed = overview?.external?.syncStatus === 'error';
    const minutes = Math.round((Date.parse(m.startsAt) - now.getTime()) / 60_000);
    return (
      <li key={m.id} className="tm-mtg-dayrow">
        <p className="tm-mtg-dayrow__time tm-mtg-mono">
          <strong>{clock(m.startsAt)}</strong>
          {m.endsAt ? <span>{clock(m.endsAt)}</span> : null}
        </p>
        <article className="tm-mtg-daycard" data-state={state}>
          <div className="tm-mtg-daycard__main">
            <h3 className="tm-mtg-daycard__title">
              <Link href={meetingHref(organizationSlug, m.id)}>{m.title}</Link>
            </h3>
            <p className="tm-mtg-daycard__meta">
              {[
                overview ? conferenceName(t, overview.conference) : null,
                projectNames.get(m.projectId) ?? null,
                overview?.location ?? null,
              ]
                .filter(Boolean)
                .map((part, index) => (
                  <span key={index} data-first={index === 0 || undefined}>
                    {index > 0 ? ' · ' : ''}
                    {part}
                  </span>
                ))}
            </p>
            {overview ? (
              <p className="tm-mtg-daycard__people">
                <AvatarStack people={overview.people} size="sm" />
                <span>{answersLine(t, overview)}</span>
              </p>
            ) : null}
          </div>
          <div className="tm-mtg-daycard__end">
            {state === 'ended' ? (
              <span className="tm-mtg-pill">{t('MeetingsHub.ended')}</span>
            ) : failed ? (
              <>
                <span className="tm-mtg-pill" data-tone="danger">
                  × {t('MeetingsHub.notSent')}
                </span>
                <button
                  type="button"
                  className="tm-mtg-btn tm-mtg-btn--outline"
                  onClick={() => onRetry(m.id)}
                >
                  {t('MeetingsHub.tryAgain')}
                </button>
              </>
            ) : (
              <>
                {state === 'next' && minutes > 0 && minutes <= 120 ? (
                  <span className="tm-mtg-mono tm-mtg-daycard__soon">
                    {fillTemplate(t('MeetingsHub.startsIn'), { n: String(minutes) })}
                  </span>
                ) : null}
                <JoinLink overview={overview} tone={state === 'next' ? 'lime' : 'outline'} />
              </>
            )}
          </div>
        </article>
      </li>
    );
  };
  return (
    <div className="tm-mtg-day__list">
      {earlier.length > 0 ? (
        <>
          <h3 className="tm-mtg-mono tm-mtg-eyebrow">{t('MeetingsHub.earlierToday')}</h3>
          <ul className="tm-mtg-daylist">{earlier.map((m) => card(m, 'ended'))}</ul>
        </>
      ) : null}
      {later.length > 0 ? (
        <>
          <h3 className="tm-mtg-mono tm-mtg-eyebrow">{t('MeetingsHub.nextHeading')}</h3>
          <ul className="tm-mtg-daylist">
            {later.map((m) => card(m, m.id === nextId ? 'next' : 'later'))}
          </ul>
        </>
      ) : null}
    </div>
  );
}

/** "Needs your answer": invitations the person has not answered, with Yes / Maybe / No. */
function Invitations({
  api,
  organizationSlug,
  meetings,
  overviews,
}: {
  api: ApiClient;
  organizationSlug: string;
  meetings: readonly MeetingView[];
  overviews: ReadonlyMap<string, MeetingOverviewView>;
}) {
  const t = useT();
  const queries = useQueryClient();
  const [answered, setAnswered] = useState<ReadonlyMap<string, MeetingRsvpResponse>>(new Map());
  const answer = useMutation({
    mutationFn: (input: { meetingId: string; response: MeetingRsvpResponse }) =>
      setMeetingRsvp(api, organizationSlug, input.meetingId, input.response),
    onSuccess: (_data, input) => {
      setAnswered((current) => new Map(current).set(input.meetingId, input.response));
      void queries.invalidateQueries({
        queryKey: ['meeting-overview', organizationSlug, input.meetingId],
      });
    },
  });
  const options: readonly [
    MeetingRsvpResponse,
    'MeetingsHub.yes' | 'MeetingsHub.maybe' | 'MeetingsHub.no',
  ][] = [
    ['accepted', 'MeetingsHub.yes'],
    ['tentative', 'MeetingsHub.maybe'],
    ['declined', 'MeetingsHub.no'],
  ];
  return (
    <section className="tm-mtg-invites" aria-labelledby="tm-mtg-invites-title">
      <p className="tm-mtg-mono tm-mtg-invites__eyebrow">{t('MeetingsHub.needsAnswer')}</p>
      <h2 id="tm-mtg-invites-title" className="tm-mtg-invites__title">
        {fillTemplate(t('MeetingsHub.invitationsCount'), { n: String(meetings.length) })}
      </h2>
      {meetings.slice(0, 4).map((m) => {
        const overview = overviews.get(m.id);
        const chosen = answered.get(m.id);
        return (
          <div key={m.id} className="tm-mtg-invite">
            <p className="tm-mtg-invite__title">{m.title}</p>
            <p className="tm-mtg-invite__when">
              {new Intl.DateTimeFormat('en-GB', {
                weekday: 'short',
                day: 'numeric',
                month: 'short',
              })
                .format(new Date(m.startsAt))
                .replace(',', '')}{' '}
              · {clock(m.startsAt)}
              {overview && overview.conference !== 'none'
                ? ` · ${conferenceName(t, overview.conference)}`
                : ''}
            </p>
            <div className="tm-mtg-invite__answers" role="group" aria-label={m.title}>
              {options.map(([response, key]) => (
                <button
                  key={response}
                  type="button"
                  aria-pressed={chosen === response}
                  onClick={() => answer.mutate({ meetingId: m.id, response })}
                >
                  {t(key)}
                </button>
              ))}
            </div>
          </div>
        );
      })}
    </section>
  );
}

/** "Your calendars": each connected calendar, its address and when it last synced. */
function YourCalendars({
  organizationSlug,
  accounts,
  now,
}: {
  organizationSlug: string;
  accounts: readonly CalendarAccount[];
  now: Date;
}) {
  const t = useT();
  return (
    <section className="tm-mtg-card tm-mtg-yours" aria-labelledby="tm-mtg-yours-title">
      <h2 id="tm-mtg-yours-title" className="tm-mtg-card__title">
        {t('MeetingsHub.yourCalendars')}
      </h2>
      <ul>
        {accounts.map((account) => (
          <li key={account.provider} data-status={account.status}>
            <span className="tm-mtg-dot" aria-hidden="true" />
            <span>
              <strong>{calendarName(account.provider)}</strong>
              <small>
                {account.status === 'connected'
                  ? [
                      account.accountEmail,
                      account.lastSyncedAt
                        ? fillTemplate(t('MeetingsHub.syncedAgo'), {
                            n: String(minutesSince(account.lastSyncedAt, now)),
                          })
                        : null,
                    ]
                      .filter(Boolean)
                      .join(' · ')
                  : account.status === 'error'
                    ? t('MeetingsHub.needsSignInShort')
                    : t('MeetingsHub.notConnected')}
              </small>
            </span>
          </li>
        ))}
      </ul>
      <Link className="tm-mtg-textlink" href={`/${organizationSlug}/settings/calendar-connections`}>
        {t('MeetingsHub.calendarSettings')}
      </Link>
    </section>
  );
}

function minutesSince(iso: string, now: Date): number {
  return Math.max(0, Math.round((now.getTime() - Date.parse(iso)) / 60_000));
}

/** Empty (419:23431): no calendar connected and nothing planned yet. */
function EmptyConnect({
  organizationSlug,
  accounts,
  api,
}: {
  organizationSlug: string;
  accounts: readonly CalendarAccount[];
  api: ApiClient;
}) {
  const t = useT();
  const connect = useMutation({
    mutationFn: (provider: 'google' | 'microsoft') =>
      startCalendarConnect(api, organizationSlug, provider),
    onSuccess: ({ url }) => {
      globalThis.location.assign(url);
    },
  });
  return (
    <>
      <section className="tm-mtg-hero" aria-labelledby="tm-mtg-hero-title">
        <p className="tm-mtg-mono tm-mtg-next__eyebrow">{t('MeetingsHub.noCalendarEyebrow')}</p>
        <h2 id="tm-mtg-hero-title" className="tm-mtg-hero__title">
          {t('MeetingsHub.noCalendarTitle')}
        </h2>
        <p className="tm-mtg-hero__body">{t('MeetingsHub.noCalendarBody')}</p>
      </section>
      <div className="tm-mtg-connect-grid">
        {accounts.map((account) => (
          <section key={account.provider} className="tm-mtg-card">
            <h3 className="tm-mtg-card__title">{calendarName(account.provider)}</h3>
            <p className="tm-mtg-quiet">
              {t(
                account.provider === 'microsoft' ? 'MeetingsHub.msCreates' : 'MeetingsHub.gCreates',
              )}
            </p>
            <span className="tm-mtg-status" data-status="not_connected">
              {t('MeetingsHub.notConnected')}
            </span>
            <button
              type="button"
              className="tm-mtg-btn tm-mtg-btn--ink"
              onClick={() => connect.mutate(account.provider)}
              disabled={connect.isPending}
            >
              {fillTemplate(t('MeetingsHub.connectNamed'), {
                provider: calendarName(account.provider),
              })}
            </button>
          </section>
        ))}
      </div>
      <section className="tm-mtg-card tm-mtg-notready">
        <div>
          <h3 className="tm-mtg-card__title">{t('MeetingsHub.notReadyTitle')}</h3>
          <p className="tm-mtg-quiet">{t('MeetingsHub.notReadyBody')}</p>
        </div>
        <Link className="tm-mtg-btn tm-mtg-btn--outline" href={`/${organizationSlug}/calendar/new`}>
          {t('MeetingsHub.planWithout')}
        </Link>
      </section>
    </>
  );
}
