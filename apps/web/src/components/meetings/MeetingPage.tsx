'use client';

import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { InlineAlert, LoadingRegion, Skeleton } from '@tmanage/ui';
import { AppShell } from '../shell/AppShell';
import { browserApiClient } from '../../lib/api/browser-client';
import type { ApiClient } from '../../lib/api/client';
import { ApiRequestError } from '../../lib/api/errors';
import {
  cancelMeeting,
  getMeetingOverview,
  listAllProjects,
  listMeetingNotes,
  removeMeeting,
  syncMeeting,
  type MeetingOverviewView,
} from '../../lib/api/meetings';
import {
  getMeetingRsvp,
  setMeetingRsvp,
  type MeetingRsvpResponse,
} from '../../lib/api/meeting-rsvp';
import {
  listMeetingActionItems,
  updateMeetingActionItem,
} from '../../lib/api/meeting-action-items';
import { fillTemplate } from '../../lib/ai-approval-presentation';
import { useT } from '../../lib/i18n/use-t';
import { appDateLocale } from '../../lib/i18n/app-locale';
import { useTOr } from '../../lib/i18n/use-t-or';
import { answerCounts, gmtOffset, parseRrule, splitReminder, timeRange } from './meeting-model';
import { calendarName, conferenceName, initialsOf } from './MeetingBits';
import { repeatSummary } from './MeetingForm';
import { CallCard, JoinButton, JoinCapsuleLine, useMeetingCall } from './MeetingCall';
import { AttendanceCard } from './MeetingAttendance';
import './meetings.css';

export interface MeetingPageScreenProps {
  organizationSlug: string;
  organizationName: string;
  meetingId: string;
  /** Arrived from Save: say the invitations went out. */
  justSaved?: boolean;
  client?: ApiClient;
  now?: Date;
}

type Translate = ReturnType<typeof useT>;

/**
 * **The meeting page (approved Figma 418:10146 EN / 418:10594 AR).** One read by id (owner bug
 * 2): the lime header with the time, zone and repeat, the Meet/Teams link and "Join" (a new tab —
 * Google and Microsoft refuse to be embedded), Edit / Cancel meeting / Open in Google Calendar, the
 * sync line with "Try again", then the agenda, notes, decisions and action items beside the
 * person's own answer, the guests and their answers, attachments, project and details.
 */
export function MeetingPageScreen({
  organizationSlug,
  organizationName,
  meetingId,
  justSaved = false,
  client,
  now: fixedNow,
}: MeetingPageScreenProps) {
  const api = client ?? browserApiClient();
  const t = useT();
  const queries = useQueryClient();
  const [now] = useState(() => fixedNow ?? new Date());
  const overviewKey = ['meeting-overview', organizationSlug, meetingId];
  const overview = useQuery({
    queryKey: overviewKey,
    queryFn: () => getMeetingOverview(api, organizationSlug, meetingId),
    retry: false,
  });
  const retry = useMutation({
    mutationFn: () => syncMeeting(api, organizationSlug, meetingId),
    onSuccess: (data) => queries.setQueryData(overviewKey, data),
  });
  const cancel = useMutation({
    mutationFn: () => cancelMeeting(api, organizationSlug, meetingId),
    onSuccess: () => {
      void queries.invalidateQueries({ queryKey: overviewKey });
      void queries.invalidateQueries({ queryKey: ['meetings', organizationSlug] });
      // The day capsule above My Day reads the calendar grid: drop the cancelled meeting there too.
      void queries.invalidateQueries({ queryKey: ['calendar-grid', organizationSlug] });
    },
  });
  const [confirming, setConfirming] = useState(false);
  const tOr = useTOr();
  const router = useRouter();
  const [confirmingRemove, setConfirmingRemove] = useState(false);
  const remove = useMutation({
    mutationFn: () => removeMeeting(api, organizationSlug, meetingId),
    onSuccess: () => {
      void queries.invalidateQueries({ queryKey: ['meetings', organizationSlug] });
      void queries.invalidateQueries({ queryKey: ['calendar-grid', organizationSlug] });
      router.push(`/${organizationSlug}/calendar`);
    },
  });

  const o = overview.data;
  // 53-12: the call card, Join (records attendance) and the state capsule.
  const call = useMeetingCall(api, organizationSlug, meetingId);
  const title = o?.meeting.title ?? t('MeetingPage.meeting');
  const base = `/${organizationSlug}/calendar/meetings/${encodeURIComponent(meetingId)}`;

  return (
    <AppShell
      organizationSlug={organizationSlug}
      organizationName={organizationName}
      activeNavigationId="calendar"
      title={title}
      eyebrow={
        <span className="tm-mtg-crumbs">
          <Link href={`/${organizationSlug}/calendar`}>{t('MeetingPage.calendar')}</Link>
          <span aria-hidden="true"> › </span>
          <span>{title}</span>
        </span>
      }
    >
      <div className="tm-mtg tm-mtg-page">
        {overview.isPending ? (
          <LoadingRegion label={t('MeetingPage.loading')}>
            <Skeleton height="200px" />
          </LoadingRegion>
        ) : null}
        {overview.isError ? (
          <InlineAlert tone="danger" title={t('MeetingPage.notFound')} live>
            {overview.error instanceof ApiRequestError && overview.error.status === 404
              ? t('MeetingPage.notFoundBody')
              : t('MeetingsHub.noAnswer')}{' '}
            <Link href={`/${organizationSlug}/calendar`}>{t('MeetingForm.backToMeetings')}</Link>
          </InlineAlert>
        ) : null}

        {o ? (
          <>
            {justSaved ? (
              <p className="tm-mtg-banner" data-tone="lime" role="status">
                {/* Live check a6f66e47 (M2): no guests, no invitation message. */}
                {o.external === null
                  ? t('MeetingPage.savedLocal')
                  : o.people.some((person) => !person.organizer)
                    ? t('MeetingPage.savedSent')
                    : fillTemplate(
                        tOr(
                          'MeetingPage.savedNoGuests',
                          'Saved. It is in your {calendar} calendar.',
                        ),
                        { calendar: calendarName(o.external.provider) },
                      )}
              </p>
            ) : null}
            {o.cancelledAt ? (
              <p className="tm-mtg-banner" data-tone="danger" role="status">
                {t('MeetingPage.cancelledBanner')}
              </p>
            ) : null}

            <Hero
              t={t}
              o={o}
              join={
                call.data && o.cancelledAt === null ? (
                  <JoinButton
                    api={api}
                    organizationSlug={organizationSlug}
                    meetingId={meetingId}
                    call={call.data}
                  />
                ) : null
              }
            />
            {call.data && o.cancelledAt === null ? (
              <JoinCapsuleLine call={call.data} startsAt={o.meeting.startsAt} now={now} />
            ) : null}

            <div className="tm-mtg-page__actions">
              {o.cancelledAt !== null ? (
                <button
                  type="button"
                  className="tm-mtg-btn tm-mtg-btn--danger"
                  onClick={() => setConfirmingRemove(true)}
                >
                  {tOr('MeetingPage.removeMeeting', 'Remove from calendar')}
                </button>
              ) : null}
              {o.cancelledAt === null ? (
                <>
                  <Link className="tm-mtg-btn tm-mtg-btn--outline" href={`${base}/edit`}>
                    {t('MeetingPage.edit')}
                  </Link>
                  <button
                    type="button"
                    className="tm-mtg-btn tm-mtg-btn--danger"
                    onClick={() => setConfirming(true)}
                  >
                    {t('MeetingPage.cancelMeeting')}
                  </button>
                </>
              ) : null}
              {o.external?.htmlLink ? (
                <a
                  className="tm-mtg-textlink"
                  href={o.external.htmlLink}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  {fillTemplate(t('MeetingPage.openIn'), {
                    calendar: calendarName(o.external.provider),
                  })}
                </a>
              ) : null}
              <SyncLine
                t={t}
                o={o}
                now={now}
                organizationSlug={organizationSlug}
                retrying={retry.isPending}
                onRetry={() => retry.mutate()}
              />
            </div>

            <nav className="tm-mtg-tabs" aria-label={t('MeetingPage.tabsAria')}>
              <Link href={base} aria-current="page">
                {t('MeetingPage.overview')}
              </Link>
              <a href="#tm-mtg-agenda">{t('MeetingPage.agenda')}</a>
              <Link href={`${base}/notes`}>{t('MeetingPage.notes')}</Link>
              <Link href={`${base}/action-items`}>{t('MeetingPage.actionItems')}</Link>
              <a href="#tm-mtg-files">{t('MeetingPage.files')}</a>
            </nav>

            <div className="tm-mtg-page__cols">
              <div className="tm-mtg-page__main">
                <AgendaCard t={t} agenda={o.meeting.agendaNote} />
                {o.cancelledAt === null ? (
                  <AttendanceCard
                    api={api}
                    organizationSlug={organizationSlug}
                    meetingId={meetingId}
                    notesHref={`${base}/notes`}
                  />
                ) : null}
                <NotesCards
                  api={api}
                  organizationSlug={organizationSlug}
                  meetingId={meetingId}
                  base={base}
                />
                <ActionItemsCard
                  api={api}
                  organizationSlug={organizationSlug}
                  meetingId={meetingId}
                  base={base}
                />
              </div>
              <div className="tm-mtg-page__side">
                {call.data && o.cancelledAt === null ? (
                  <CallCard
                    api={api}
                    organizationSlug={organizationSlug}
                    meetingId={meetingId}
                    title={o.meeting.title}
                    call={call.data}
                  />
                ) : null}
                {o.cancelledAt === null ? (
                  <Going api={api} organizationSlug={organizationSlug} o={o} />
                ) : null}
                <GuestsCard t={t} o={o} />
                <FilesCard t={t} o={o} />
                <ProjectCard api={api} organizationSlug={organizationSlug} o={o} />
                <DetailsCard t={t} o={o} />
              </div>
            </div>

            {remove.isError ? (
              <InlineAlert
                tone="danger"
                title={tOr('MeetingPage.removeFailed', 'Not removed')}
                live
              >
                {remove.error instanceof ApiRequestError
                  ? remove.error.message
                  : t('MeetingsHub.noAnswer')}
              </InlineAlert>
            ) : null}
            {confirmingRemove ? (
              <CancelDialog
                t={t}
                pending={remove.isPending}
                notifies={false}
                copy={{
                  title: tOr('MeetingPage.removeTitle', 'Remove this meeting?'),
                  body: tOr(
                    'MeetingPage.removeBody',
                    'It leaves the calendar for everyone. Nobody is notified again, because the meeting is already cancelled.',
                  ),
                  keep: tOr('MeetingPage.keepIt', 'Keep it'),
                  confirm: tOr('MeetingPage.removeConfirm', 'Remove meeting'),
                }}
                onClose={() => setConfirmingRemove(false)}
                onConfirm={() =>
                  remove.mutate(undefined, { onSettled: () => setConfirmingRemove(false) })
                }
              />
            ) : null}
            {confirming ? (
              <CancelDialog
                t={t}
                pending={cancel.isPending}
                notifies={o.external !== null}
                onClose={() => setConfirming(false)}
                onConfirm={() =>
                  cancel.mutate(undefined, { onSettled: () => setConfirming(false) })
                }
              />
            ) : null}
          </>
        ) : null}
      </div>
    </AppShell>
  );
}

function Hero({ t, o, join }: { t: Translate; o: MeetingOverviewView; join: ReactNode }) {
  const start = new Date(o.meeting.startsAt);
  const rule = parseRrule(o.rrule);
  const day = new Intl.DateTimeFormat(appDateLocale(), {
    weekday: 'long',
    day: 'numeric',
    month: 'short',
  })
    .format(start)
    .replace(',', '');
  const zone = (o.timeZone ?? '').split('/').pop()?.replace(/_/g, ' ') ?? '';
  const eyebrow = [
    day,
    o.allDay ? t('MeetingsHub.allDay') : timeRange(o.meeting.startsAt, o.meeting.endsAt),
    zone ? `${zone} (${gmtOffset(start)})` : gmtOffset(start),
    rule ? repeatSummary(t, rule, start).split(' · ')[0] : null,
  ]
    .filter(Boolean)
    .join(' · ')
    .toUpperCase();
  const joinUrl = o.cancelledAt === null ? (o.external?.joinUrl ?? null) : null;
  return (
    <section className="tm-mtg-hero-lime" data-cancelled={o.cancelledAt !== null || undefined}>
      <div>
        <p className="tm-mtg-mono tm-mtg-hero-lime__eyebrow">{eyebrow}</p>
        <p className="tm-mtg-hero-lime__title" aria-hidden="true">
          {o.meeting.title}
        </p>
        <p className="tm-mtg-hero-lime__call">
          <span>{conferenceName(t, o.conference)}</span>
          {joinUrl ? (
            <span className="tm-mtg-mono">{joinUrl.replace(/^https:\/\//, '')}</span>
          ) : null}
        </p>
      </div>
      {/* 53-12: Join goes through the API, which records attendance and answers the link. */}
      {join}
    </section>
  );
}

function SyncLine({
  t,
  o,
  now,
  organizationSlug,
  retrying,
  onRetry,
}: {
  t: Translate;
  o: MeetingOverviewView;
  now: Date;
  organizationSlug: string;
  retrying: boolean;
  onRetry: () => void;
}) {
  const external = o.external;
  if (!external) {
    return (
      <p className="tm-mtg-syncline" data-status="none">
        <span className="tm-mtg-dot" aria-hidden="true" />
        {t('MeetingPage.tmanageOnly')}{' '}
        <Link href={`/${organizationSlug}/settings/calendar-connections`}>
          {t('MeetingForm.connectCalendar')}
        </Link>
      </p>
    );
  }
  const calendar = calendarName(external.provider);
  if (external.syncStatus === 'error') {
    return (
      <p className="tm-mtg-syncline" data-status="error" role="status">
        <span className="tm-mtg-dot" aria-hidden="true" />
        {fillTemplate(t('MeetingPage.syncError'), { calendar })}
        <button
          type="button"
          className="tm-mtg-btn tm-mtg-btn--outline"
          onClick={onRetry}
          disabled={retrying}
        >
          {t('MeetingsHub.tryAgain')}
        </button>
      </p>
    );
  }
  const at = external.lastPulledAt ?? external.lastPushedAt;
  const minutes = at ? Math.max(0, Math.round((now.getTime() - Date.parse(at)) / 60_000)) : null;
  return (
    <p className="tm-mtg-syncline" data-status={external.syncStatus}>
      <span className="tm-mtg-dot" aria-hidden="true" />
      {external.syncStatus === 'pending'
        ? fillTemplate(t('MeetingPage.syncPending'), { calendar })
        : fillTemplate(t('MeetingPage.syncOk'), { calendar })}
      {minutes !== null && external.syncStatus !== 'pending'
        ? ` · ${fillTemplate(t('MeetingPage.minAgo'), { n: String(minutes) })}`
        : ''}
    </p>
  );
}

function AgendaCard({ t, agenda }: { t: Translate; agenda: string | null }) {
  const lines = (agenda ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  const items = lines.filter((line) => /^(\d+[.)]|[-•*])\s+/.test(line));
  const intro = lines.filter((line) => !/^(\d+[.)]|[-•*])\s+/.test(line));
  return (
    <section className="tm-mtg-card" id="tm-mtg-agenda" aria-labelledby="tm-mtg-agenda-title">
      <h2 id="tm-mtg-agenda-title" className="tm-mtg-card__title">
        {t('MeetingPage.agenda')}
      </h2>
      {lines.length === 0 ? <p className="tm-mtg-quiet">{t('MeetingPage.noAgenda')}</p> : null}
      {intro.map((line, index) => (
        <p key={index} className="tm-mtg-body">
          {line}
        </p>
      ))}
      {items.length > 0 ? (
        <ol className="tm-mtg-agenda">
          {items.map((line, index) => {
            const text = line.replace(/^(\d+[.)]|[-•*])\s+/, '');
            const [head, ...rest] = text.split(/\s+[—–-]\s+/);
            return (
              <li key={index}>
                <span className="tm-mtg-agenda__num" data-first={index === 0 || undefined}>
                  {index + 1}
                </span>
                <span>
                  <strong>{head}</strong>
                  {rest.length > 0 ? <small>{rest.join(' · ')}</small> : null}
                </span>
              </li>
            );
          })}
        </ol>
      ) : null}
    </section>
  );
}

function NotesCards({
  api,
  organizationSlug,
  meetingId,
  base,
}: {
  api: ApiClient;
  organizationSlug: string;
  meetingId: string;
  base: string;
}) {
  const t = useT();
  const notes = useQuery({
    queryKey: ['meeting-notes', organizationSlug, meetingId],
    queryFn: () => listMeetingNotes(api, organizationSlug, meetingId),
    retry: false,
  });
  const all = notes.data?.notes ?? [];
  const plain = all.filter((n) => n.kind === 'note');
  const decisions = all.filter((n) => n.kind === 'decision');
  const latest = plain[plain.length - 1];
  return (
    <>
      <section className="tm-mtg-card" aria-labelledby="tm-mtg-notes-title">
        <h2 id="tm-mtg-notes-title" className="tm-mtg-card__title">
          {t('MeetingPage.notes')}
        </h2>
        {latest ? (
          <p className="tm-mtg-body">{latest.body}</p>
        ) : (
          <p className="tm-mtg-quiet">{t('MeetingPage.noNotes')}</p>
        )}
        <div className="tm-mtg-card__foot">
          {latest ? (
            <small className="tm-mtg-quiet">
              {fillTemplate(t('MeetingPage.lastEdited'), {
                time: new Intl.DateTimeFormat(appDateLocale(), {
                  hour: '2-digit',
                  minute: '2-digit',
                }).format(new Date(latest.createdAt)),
              })}
            </small>
          ) : (
            <span />
          )}
          <Link className="tm-mtg-textlink" href={`${base}/notes`}>
            {t('MeetingPage.editNotes')}
          </Link>
        </div>
      </section>
      {decisions.length > 0 ? (
        <section className="tm-mtg-card" aria-labelledby="tm-mtg-decisions-title">
          <h2 id="tm-mtg-decisions-title" className="tm-mtg-card__title">
            {t('MeetingPage.decisions')}
          </h2>
          <ul className="tm-mtg-decisions">
            {decisions.map((decision) => (
              <li key={decision.id}>
                <span className="tm-mtg-tag tm-mtg-mono">{t('MeetingPage.decision')}</span>
                <span>{decision.body}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </>
  );
}

function ActionItemsCard({
  api,
  organizationSlug,
  meetingId,
  base,
}: {
  api: ApiClient;
  organizationSlug: string;
  meetingId: string;
  base: string;
}) {
  const t = useT();
  const queries = useQueryClient();
  const key = ['meeting-action-items', organizationSlug, meetingId];
  const items = useQuery({
    queryKey: key,
    queryFn: () => listMeetingActionItems(api, organizationSlug, meetingId),
    retry: false,
  });
  const toggle = useMutation({
    mutationFn: (input: { id: string; done: boolean }) =>
      updateMeetingActionItem(api, organizationSlug, meetingId, input.id, {
        status: input.done ? 'done' : 'open',
      }),
    onSuccess: () => void queries.invalidateQueries({ queryKey: key }),
  });
  const list = items.data?.actionItems ?? [];
  return (
    <section className="tm-mtg-card" aria-labelledby="tm-mtg-actions-title">
      <h2 id="tm-mtg-actions-title" className="tm-mtg-card__title">
        {t('MeetingPage.actionItems')}
      </h2>
      {list.length === 0 ? <p className="tm-mtg-quiet">{t('MeetingPage.noActions')}</p> : null}
      <ul className="tm-mtg-actions">
        {list.map((item) => (
          <li key={item.id} data-done={item.status === 'done' || undefined}>
            <label className="tm-mtg-check">
              <input
                type="checkbox"
                checked={item.status === 'done'}
                onChange={(event) => toggle.mutate({ id: item.id, done: event.target.checked })}
              />
              <span>{item.title}</span>
            </label>
            <span className="tm-mtg-mono tm-mtg-quiet">
              {item.status === 'done'
                ? t('MeetingPage.done')
                : item.dueOn
                  ? fillTemplate(t('MeetingPage.due'), {
                      date: new Intl.DateTimeFormat(appDateLocale(), {
                        day: 'numeric',
                        month: 'short',
                      }).format(new Date(`${item.dueOn}T12:00`)),
                    })
                  : ''}
            </span>
          </li>
        ))}
      </ul>
      <Link className="tm-mtg-textlink" href={`${base}/action-items`}>
        + {t('MeetingPage.addAction')}
      </Link>
    </section>
  );
}

function Going({
  api,
  organizationSlug,
  o,
}: {
  api: ApiClient;
  organizationSlug: string;
  o: MeetingOverviewView;
}) {
  const t = useT();
  const queries = useQueryClient();
  const meetingId = o.meeting.id;
  const rsvp = useQuery({
    queryKey: ['meeting-rsvp', organizationSlug, meetingId],
    queryFn: () => getMeetingRsvp(api, organizationSlug, meetingId),
    retry: false,
  });
  const answer = useMutation({
    mutationFn: (response: MeetingRsvpResponse) =>
      setMeetingRsvp(api, organizationSlug, meetingId, response),
    onSuccess: (data) => {
      queries.setQueryData(['meeting-rsvp', organizationSlug, meetingId], data);
      void queries.invalidateQueries({
        queryKey: ['meeting-overview', organizationSlug, meetingId],
      });
    },
  });
  if (rsvp.isError) return null;
  const options: readonly [
    MeetingRsvpResponse,
    'MeetingsHub.yes' | 'MeetingsHub.maybe' | 'MeetingsHub.no',
  ][] = [
    ['accepted', 'MeetingsHub.yes'],
    ['tentative', 'MeetingsHub.maybe'],
    ['declined', 'MeetingsHub.no'],
  ];
  return (
    <section className="tm-mtg-going" aria-labelledby="tm-mtg-going-title">
      <h2 id="tm-mtg-going-title" className="tm-mtg-going__title">
        {t('MeetingPage.areYouGoing')}
      </h2>
      <div className="tm-mtg-invite__answers" role="group" aria-labelledby="tm-mtg-going-title">
        {options.map(([response, key]) => (
          <button
            key={response}
            type="button"
            aria-pressed={rsvp.data?.response === response}
            disabled={answer.isPending}
            onClick={() => answer.mutate(response)}
          >
            {t(key)}
          </button>
        ))}
      </div>
      {o.external ? (
        <p className="tm-mtg-going__note">
          {fillTemplate(t('MeetingPage.answerSentToo'), {
            calendar: calendarName(o.external.provider),
          })}
        </p>
      ) : null}
    </section>
  );
}

const RSVP_KEYS = {
  accepted: 'MeetingPage.accepted',
  tentative: 'MeetingPage.maybe',
  declined: 'MeetingPage.declined',
  invited: 'MeetingPage.awaiting',
} as const;

function GuestsCard({ t, o }: { t: Translate; o: MeetingOverviewView }) {
  const counts = answerCounts(o.people);
  return (
    <section className="tm-mtg-card" aria-labelledby="tm-mtg-guests-title">
      <div className="tm-mtg-card__head">
        <h2 id="tm-mtg-guests-title" className="tm-mtg-card__title">
          {t('MeetingForm.guests')}
        </h2>
        <span className="tm-mtg-quiet">{counts.total}</span>
      </div>
      <p className="tm-mtg-pills">
        {counts.yes ? (
          <span className="tm-mtg-pill" data-rsvp="accepted">
            ✓ {fillTemplate(t('MeetingsHub.countYes'), { n: String(counts.yes) })}
          </span>
        ) : null}
        {counts.maybe ? (
          <span className="tm-mtg-pill" data-rsvp="tentative">
            {fillTemplate(t('MeetingsHub.countMaybe'), { n: String(counts.maybe) })}
          </span>
        ) : null}
        {counts.no ? (
          <span className="tm-mtg-pill" data-rsvp="declined">
            × {fillTemplate(t('MeetingsHub.countNo'), { n: String(counts.no) })}
          </span>
        ) : null}
        {counts.awaiting ? (
          <span className="tm-mtg-pill" data-rsvp="invited">
            {fillTemplate(t('MeetingsHub.countAwaiting'), { n: String(counts.awaiting) })}
          </span>
        ) : null}
      </p>
      <ul className="tm-mtg-guests">
        {o.people.map((person) => {
          const name = person.displayName ?? person.email ?? '';
          return (
            <li key={`${person.kind}:${person.id}`} className="tm-mtg-guest">
              <span className="tm-mtg-avatar" data-kind={person.kind} aria-hidden="true">
                {initialsOf(person.kind === 'guest' ? null : person.displayName, person.email)}
              </span>
              <span className="tm-mtg-guest__who">
                <strong>
                  {person.kind === 'guest' ? (person.email ?? name) : name}
                  {person.optional ? (
                    <span className="tm-mtg-tag tm-mtg-mono">{t('MeetingForm.optional')}</span>
                  ) : null}
                </strong>
                <small>
                  {person.organizer
                    ? t('MeetingForm.organizer')
                    : person.kind === 'guest'
                      ? t('MeetingForm.outsideGuest')
                      : person.kind === 'client'
                        ? t('MeetingPage.client')
                        : ''}
                </small>
              </span>
              <span className="tm-mtg-pill" data-rsvp={person.rsvp}>
                {t(RSVP_KEYS[person.rsvp])}
              </span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function FilesCard({ t, o }: { t: Translate; o: MeetingOverviewView }) {
  return (
    <section className="tm-mtg-card" id="tm-mtg-files" aria-labelledby="tm-mtg-files-title">
      <h2 id="tm-mtg-files-title" className="tm-mtg-card__title">
        {t('MeetingForm.attachments')}
      </h2>
      {o.attachments.length === 0 ? (
        <p className="tm-mtg-quiet">{t('MeetingPage.noFiles')}</p>
      ) : null}
      {o.attachments.map((file) => (
        <div key={file.id} className="tm-mtg-file">
          <span className="tm-mtg-file__icon" aria-hidden="true" />
          <span>
            <strong>{file.title}</strong>
            <small>{file.provider === 'onedrive' ? 'OneDrive' : 'Google Drive'}</small>
          </span>
          {file.webUrl ? (
            <a
              className="tm-mtg-textlink"
              href={file.webUrl}
              target="_blank"
              rel="noopener noreferrer"
            >
              {t('MeetingPage.open')}
              <span className="tm-visually-hidden"> {file.title}</span>
            </a>
          ) : null}
        </div>
      ))}
    </section>
  );
}

function ProjectCard({
  api,
  organizationSlug,
  o,
}: {
  api: ApiClient;
  organizationSlug: string;
  o: MeetingOverviewView;
}) {
  const t = useT();
  const projects = useQuery({
    queryKey: ['projects', organizationSlug],
    queryFn: () => listAllProjects(api, organizationSlug),
  });
  const project = (projects.data ?? []).find((p) => p.id === o.meeting.projectId);
  return (
    <section className="tm-mtg-card" aria-labelledby="tm-mtg-project-title">
      <h2 id="tm-mtg-project-title" className="tm-mtg-card__title">
        {t('MeetingPage.project')}
      </h2>
      <div className="tm-mtg-project">
        <strong>{project?.name ?? '—'}</strong>
        <Link
          className="tm-mtg-btn tm-mtg-btn--outline"
          href={`/${organizationSlug}/projects/${encodeURIComponent(o.meeting.projectId)}`}
        >
          {t('MeetingPage.open')}
        </Link>
      </div>
    </section>
  );
}

function DetailsCard({ t, o }: { t: Translate; o: MeetingOverviewView }) {
  const reminderText =
    o.reminders === null
      ? t('MeetingPage.defaultReminders')
      : o.reminders.length === 0
        ? t('MeetingPage.noReminders')
        : o.reminders
            .map((r) => {
              const { amount, unit } = splitReminder(r.minutes);
              return fillTemplate(t('MeetingPage.reminderLine'), {
                method:
                  r.method === 'email' ? t('MeetingForm.email') : t('MeetingForm.notification'),
                n: String(amount),
                unit: t(
                  {
                    minutes: 'MeetingForm.unitMinutes',
                    hours: 'MeetingForm.unitHours',
                    days: 'MeetingForm.unitDays',
                    weeks: 'MeetingForm.unitWeeks',
                  }[unit] as 'MeetingForm.unitMinutes',
                ),
              });
            })
            .join(' · ');
  const visibilityKey =
    o.visibility === 'public'
      ? 'MeetingForm.visPublic'
      : o.visibility === 'private'
        ? 'MeetingForm.visPrivate'
        : 'MeetingForm.visDefault';
  return (
    <section className="tm-mtg-card" aria-labelledby="tm-mtg-details-title">
      <h2 id="tm-mtg-details-title" className="tm-mtg-card__title">
        {t('MeetingForm.details')}
      </h2>
      <dl className="tm-mtg-details">
        {o.location ? (
          <>
            <dt>{t('MeetingForm.location')}</dt>
            <dd>{o.location}</dd>
          </>
        ) : null}
        <dt>{t('MeetingForm.reminders')}</dt>
        <dd>{reminderText}</dd>
        <dt>{t('MeetingForm.calendar')}</dt>
        <dd>{o.external ? calendarName(o.external.provider) : t('MeetingForm.tmanageOnly')}</dd>
        <dt>{t('MeetingPage.showsAs')}</dt>
        <dd>
          {o.showAs === 'free' ? t('MeetingForm.free') : t('MeetingForm.busy')} ·{' '}
          {fillTemplate(t('MeetingPage.visibilityLine'), { v: t(visibilityKey) })}
        </dd>
      </dl>
    </section>
  );
}

function CancelDialog({
  t,
  pending,
  notifies,
  copy,
  onClose,
  onConfirm,
}: {
  t: Translate;
  pending: boolean;
  notifies: boolean;
  /** The same dialog for "Remove from calendar". */
  copy?: { title: string; body: string; keep: string; confirm: string };
  onClose: () => void;
  onConfirm: () => void;
}) {
  const titleId = useId();
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const node = dialog.current;
    if (node && !node.open && typeof node.showModal === 'function') node.showModal();
  }, []);
  return (
    <dialog
      ref={dialog}
      className="tm-mtg-dialog"
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      <h2 id={titleId} className="tm-mtg-card__title tm-mtg-dialog__title">
        {copy?.title ?? t('MeetingPage.cancelTitle')}
      </h2>
      <p className="tm-mtg-body">
        {copy?.body ?? (notifies ? t('MeetingPage.cancelNotifies') : t('MeetingPage.cancelLocal'))}
      </p>
      <div className="tm-mtg-dialog__actions">
        <button type="button" className="tm-mtg-btn tm-mtg-btn--outline" onClick={onClose}>
          {copy?.keep ?? t('MeetingPage.keepMeeting')}
        </button>
        <button
          type="button"
          className="tm-mtg-btn tm-mtg-btn--danger"
          onClick={onConfirm}
          disabled={pending}
        >
          {copy?.confirm ?? t('MeetingPage.cancelConfirm')}
        </button>
      </div>
    </dialog>
  );
}
