'use client';

import { useState } from 'react';
import { skipToken, useQuery } from '@tanstack/react-query';
import {
  Badge,
  Button,
  Field,
  InlineAlert,
  LoadingRegion,
  Select,
  Skeleton,
  StateCapsule,
  type CapsuleState,
} from '@tmanage/ui';
import { AppShell } from '../../shell/AppShell';
import { browserApiClient } from '../../../lib/api/browser-client';
import type { ApiClient } from '../../../lib/api/client';
import { OFFLINE_LINES, useDescribeApiError } from '../../../lib/api/describe-error';
import { listProjects } from '../../../lib/api/projects';
import { getTeamDay, getTeamTime } from '../../../lib/api/time-auto';
import type {
  CurrentTask,
  DeviceKind,
  TeamLiveState,
  TeamPerson,
  TeamSession,
  TeamTimeQuery,
} from '../../../lib/api/time-auto';
import { formatDuration, timeZoneCity } from '../../../lib/i18n/duration';
import { useActiveLocale } from '../../../lib/i18n/use-active-locale';
import { useDisplayFormatters } from '../../../lib/i18n/use-formatters';
import { useTOr } from '../../../lib/i18n/use-t-or';
import { FinanceCoreNav, useFinanceMe } from './FinanceCoreNav';

export interface FinanceTeamTimeScreenProps {
  organizationSlug: string;
  organizationName: string;
  client?: ApiClient;
}

type TOr = ReturnType<typeof useTOr>;

const LIVE: Readonly<Record<TeamLiveState, readonly [string, string, CapsuleState]>> = {
  tracking: ['TeamTime.live.tracking', 'Tracking', 'current'],
  manual: ['TeamTime.live.manual', 'Manual timer', 'current'],
  paused: ['TeamTime.live.paused', 'Paused, computer idle', 'waiting'],
  off: ['TeamTime.live.off', 'Off', 'neutral'],
};

/**
 * FIX-2026-11-10 — **Team time.** Everyone's tracked time in the company: live state, current
 * task, today, this week and the chosen range, with a day drill-down (each session's start, end,
 * task, automatic or manual). Read-only: corrections stay in timesheets. Shown to holders of
 * `time.view_team` (owner, admins, people an admin authorized); the API checks it on every call
 * and only ever returns this company's people. No screenshots, keystrokes, app names or URLs exist.
 */
export function FinanceTeamTimeScreen({
  organizationSlug,
  organizationName,
  client,
}: FinanceTeamTimeScreenProps) {
  const tOr = useTOr();
  const describeError = useDescribeApiError(OFFLINE_LINES);
  const format = useDisplayFormatters();
  const api = client ?? browserApiClient();
  const { me, can } = useFinanceMe(api, organizationSlug);
  const allowed = me === undefined ? undefined : can('time.view_team');

  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [projectId, setProjectId] = useState('');
  const [membershipId, setMembershipId] = useState('');
  const [open, setOpen] = useState<{ membershipId: string; day: string } | null>(null);

  const range: TeamTimeQuery = { from, to, projectId };
  const everyone = useQuery({
    queryKey: ['team-time', organizationSlug, from, to, projectId, ''],
    queryFn: () => getTeamTime(api, organizationSlug, range),
    enabled: allowed === true,
    retry: false,
  });
  const view = useQuery({
    queryKey: ['team-time', organizationSlug, from, to, projectId, membershipId],
    queryFn: () => getTeamTime(api, organizationSlug, { ...range, membershipId }),
    enabled: allowed === true,
    retry: false,
  });
  const projects = useQuery({
    queryKey: ['projects', organizationSlug],
    queryFn: () => listProjects(api, organizationSlug),
    enabled: allowed === true,
  });
  const day = useQuery({
    queryKey: ['team-time-day', organizationSlug, open?.membershipId, open?.day],
    queryFn:
      open === null
        ? skipToken
        : () => getTeamDay(api, organizationSlug, open.membershipId, open.day),
    retry: false,
  });

  const data = view.data;
  // Item 11: a session's clock times in the company's zone, not the viewer's computer's.
  const dayZone = day.data?.timeZone ?? data?.timeZone;
  const clock = (iso: string) =>
    format.time(iso, { timeStyle: 'short', ...(dayZone ? { timeZone: dayZone } : {}) });
  const locale = useActiveLocale();
  // Item 10: durations in the reader's language; item 11: the zone by a readable name.
  const minutes = (value: number) => formatDuration(value, locale);
  const zoneName = (zone: string | undefined) =>
    zone === undefined ? '…' : timeZoneCity(zone, locale);

  return (
    <AppShell
      organizationSlug={organizationSlug}
      organizationName={organizationName}
      activeNavigationId="finance"
      eyebrow={tOr('FinanceCore.eyebrow', 'Finance')}
      title={tOr('TeamTime.title', 'Team time')}
      description={tOr(
        'TeamTime.description',
        'See who is working now and how much time each person tracked. Only active or idle state and times are recorded.',
      )}
    >
      <div className="tm-stack">
        <FinanceCoreNav organizationSlug={organizationSlug} active="team-time" />

        {allowed === false ? (
          <InlineAlert tone="neutral" title={tOr('TeamTime.noAccessTitle', 'Not available to you')}>
            {tOr(
              'TeamTime.noAccessBody',
              'Team time is for the company owner, admins and people an admin authorized. You can see your own time in Timesheets.',
            )}
          </InlineAlert>
        ) : null}

        {allowed === true ? (
          <>
            <section className="tm-panel tm-stack" aria-labelledby="tm-team-time-filters">
              <h2 id="tm-team-time-filters" className="tm-eyebrow">
                {tOr('TeamTime.filters', 'Filters')}
              </h2>
              <div className="tm-row tm-row--wrap">
                <Field
                  label={tOr('TeamTime.from', 'From')}
                  name="from"
                  type="date"
                  value={from || (data?.from ?? '')}
                  onChange={(event) => setFrom(event.target.value)}
                />
                <Field
                  label={tOr('TeamTime.to', 'To')}
                  name="to"
                  type="date"
                  value={to || (data?.to ?? '')}
                  onChange={(event) => setTo(event.target.value)}
                />
                <Select
                  label={tOr('TeamTime.person', 'Person')}
                  value={membershipId}
                  onChange={(event) => setMembershipId(event.target.value)}
                >
                  <option value="">{tOr('TeamTime.everyone', 'Everyone')}</option>
                  {(everyone.data?.people ?? []).map((person) => (
                    <option key={person.membershipId} value={person.membershipId}>
                      {person.displayName}
                    </option>
                  ))}
                </Select>
                <Select
                  label={tOr('TeamTime.project', 'Project')}
                  value={projectId}
                  onChange={(event) => setProjectId(event.target.value)}
                >
                  <option value="">{tOr('TeamTime.allProjects', 'All projects')}</option>
                  {(projects.data ?? []).map((project) => (
                    <option key={project.id} value={project.id}>
                      {project.name}
                    </option>
                  ))}
                </Select>
              </div>
              <p className="tm-field__hint">
                {tOr(
                  'TeamTime.rangeHintCity',
                  'Up to 62 days. Days and clock times follow the company time zone ({zone}). Time with no task chosen counts as unassigned time.',
                ).replace('{zone}', zoneName(data?.timeZone))}
              </p>
              <p className="tm-field__hint">
                {tOr(
                  'TeamTime.deviceNote',
                  'Automatic time is reported by each person’s own computer, not verified. A day over 12 hours or a session over 6 hours without a break is marked for review. People allowed to see Team time also see where each person’s tracking runs: the desktop app, or a browser and whether it was allowed.',
                )}
              </p>
            </section>

            {view.isError ? (
              <InlineAlert
                tone="danger"
                title={tOr('TeamTime.loadError', 'Team time could not be loaded')}
                live
              >
                {describeError(view.error)}
              </InlineAlert>
            ) : null}
            {view.isPending ? (
              <LoadingRegion label={tOr('TeamTime.loading', 'Loading team time')}>
                <Skeleton height="var(--row)" />
                <Skeleton height="var(--row)" />
              </LoadingRegion>
            ) : null}

            {data ? (
              <section className="tm-panel tm-stack" aria-labelledby="tm-team-time-people">
                <h2 id="tm-team-time-people" className="tm-eyebrow">
                  {tOr('TeamTime.people', 'People')} · {format.day(data.from)} –{' '}
                  {format.day(data.to)}
                </h2>
                {data.people.length === 0 ? (
                  <InlineAlert tone="neutral">
                    {tOr('TeamTime.empty', 'Nobody tracked time in this range.')}
                  </InlineAlert>
                ) : (
                  <div className="tm-table-scroll">
                    <table className="tm-table" aria-label={tOr('TeamTime.people', 'People')}>
                      <thead>
                        <tr>
                          <th scope="col">{tOr('TeamTime.person', 'Person')}</th>
                          <th scope="col">{tOr('TeamTime.now', 'Now')}</th>
                          <th scope="col">{tOr('TeamTime.currentTask', 'Working on')}</th>
                          <th scope="col">{tOr('TeamTime.today', 'Today')}</th>
                          <th scope="col">{tOr('TeamTime.week', 'This week')}</th>
                          <th scope="col">{tOr('TeamTime.range', 'Range')}</th>
                          <th scope="col">{tOr('TeamTime.device', 'Where it runs')}</th>
                          <th scope="col">
                            <span className="tm-visually-hidden">
                              {tOr('TeamTime.details', 'Details')}
                            </span>
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        {data.people.map((person) => (
                          <PersonRow
                            key={person.membershipId}
                            person={person}
                            minutes={minutes}
                            tOr={tOr}
                            onOpen={() =>
                              setOpen({ membershipId: person.membershipId, day: data.today })
                            }
                          />
                        ))}
                        <tr>
                          <th scope="row">{tOr('TeamTime.total', 'Total')}</th>
                          <td />
                          <td />
                          <td>
                            <Minutes
                              filed={data.totals.todayMinutes}
                              inProgress={data.totals.inProgressMinutes}
                              minutes={minutes}
                              tOr={tOr}
                            />
                          </td>
                          <td>{minutes(data.totals.weekMinutes)}</td>
                          <td>{minutes(data.totals.rangeMinutes)}</td>
                          <td />
                          <td />
                        </tr>
                      </tbody>
                    </table>
                  </div>
                )}
              </section>
            ) : null}

            {open !== null ? (
              <section className="tm-panel tm-stack" aria-labelledby="tm-team-time-day">
                <div className="tm-row tm-row--between tm-row--wrap">
                  <h2 id="tm-team-time-day" className="tm-eyebrow">
                    {day.data?.displayName ?? tOr('TeamTime.dayTitle', 'Day')} ·{' '}
                    {format.day(open.day)}
                  </h2>
                  <p className="tm-field__hint">
                    {tOr('TeamTime.clockZone', 'Clock times in {zone} time.').replace(
                      '{zone}',
                      zoneName(dayZone),
                    )}
                  </p>
                  <div className="tm-row tm-row--wrap">
                    <Field
                      label={tOr('TeamTime.day', 'Day')}
                      name="day"
                      type="date"
                      value={open.day}
                      onChange={(event) =>
                        event.target.value !== '' &&
                        setOpen({ membershipId: open.membershipId, day: event.target.value })
                      }
                    />
                    <Button size="compact" tone="text" onClick={() => setOpen(null)}>
                      {tOr('TeamTime.close', 'Close')}
                    </Button>
                  </div>
                </div>
                {day.isError ? (
                  <InlineAlert
                    tone="danger"
                    title={tOr('TeamTime.dayError', 'The day could not be loaded')}
                    live
                  >
                    {describeError(day.error)}
                  </InlineAlert>
                ) : null}
                {day.isPending ? (
                  <LoadingRegion label={tOr('TeamTime.loading', 'Loading team time')}>
                    <Skeleton height="var(--row)" />
                  </LoadingRegion>
                ) : null}
                {day.data && day.data.sessions.length === 0 ? (
                  <InlineAlert tone="neutral">
                    {tOr('TeamTime.dayEmpty', 'No time tracked on this day.')}
                  </InlineAlert>
                ) : null}
                {day.data && day.data.sessions.length > 0 ? (
                  <div className="tm-table-scroll">
                    <table className="tm-table" aria-label={tOr('TeamTime.sessions', 'Sessions')}>
                      <thead>
                        <tr>
                          <th scope="col">{tOr('TeamTime.start', 'Start')}</th>
                          <th scope="col">{tOr('TeamTime.end', 'End')}</th>
                          <th scope="col">{tOr('TeamTime.task', 'Task')}</th>
                          <th scope="col">{tOr('TeamTime.how', 'How')}</th>
                          <th scope="col">{tOr('TeamTime.duration', 'Time')}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {day.data.sessions.map((session, index) => (
                          <tr key={session.id ?? `open-${index}`}>
                            <td>{session.startedAt ? clock(session.startedAt) : '—'}</td>
                            <td>
                              {session.open
                                ? tOr('TeamTime.ongoing', 'Still going')
                                : session.endedAt
                                  ? clock(session.endedAt)
                                  : '—'}
                            </td>
                            <td>
                              {session.private
                                ? tOr('TeamTime.privateTask', 'Private task')
                                : (session.workItemTitle ??
                                  tOr('Time.unassigned', 'Unassigned time'))}
                            </td>
                            <td>
                              <SessionHow session={session} tOr={tOr} format={format} />
                            </td>
                            <td>{minutes(session.minutes)}</td>
                          </tr>
                        ))}
                        <tr>
                          <th scope="row" colSpan={4}>
                            {tOr('TeamTime.total', 'Total')}
                          </th>
                          <td>
                            <Minutes
                              filed={day.data.totalMinutes}
                              inProgress={day.data.inProgressMinutes}
                              minutes={minutes}
                              tOr={tOr}
                            />
                          </td>
                        </tr>
                      </tbody>
                    </table>
                  </div>
                ) : null}
                <p className="tm-field__hint">
                  {tOr(
                    'TeamTime.readOnly',
                    'This view is read-only. To correct time, use Timesheets.',
                  )}
                </p>
              </section>
            ) : null}
          </>
        ) : null}
      </div>
    </AppShell>
  );
}

function PersonRow({
  person,
  minutes,
  tOr,
  onOpen,
}: {
  person: TeamPerson;
  minutes: (value: number) => string;
  tOr: TOr;
  onOpen: () => void;
}) {
  const [key, english, tone] = LIVE[person.live];
  return (
    <tr>
      <th scope="row">
        {person.displayName}{' '}
        {person.needsReview ? <Badge>{tOr('TeamTime.needsReview', 'Needs review')}</Badge> : null}
      </th>
      <td>
        <StateCapsule state={tone}>{tOr(key, english)}</StateCapsule>
      </td>
      <td>{taskLabel(person.currentTask, tOr)}</td>
      <td>
        <Minutes
          filed={person.todayMinutes}
          inProgress={person.inProgressMinutes}
          minutes={minutes}
          tOr={tOr}
        />
      </td>
      <td>{minutes(person.weekMinutes)}</td>
      <td>{minutes(person.rangeMinutes)}</td>
      <td>
        <DeviceCell device={person.device} tOr={tOr} />
      </td>
      <td>
        <Button size="compact" tone="outline" onClick={onOpen}>
          {tOr('TeamTime.openDay', 'Sessions')}
        </Button>
      </td>
    </tr>
  );
}

function taskLabel(task: CurrentTask | null, tOr: TOr): string {
  if (task === null) return '—';
  if (task.private === true) return tOr('TeamTime.privateTask', 'Private task');
  return task.title ?? tOr('Time.unassigned', 'Unassigned time');
}

/** Filed time, and the open session apart from it (the timesheet counts filed time only). */
function Minutes({
  filed,
  inProgress,
  minutes,
  tOr,
}: {
  filed: number;
  inProgress: number;
  minutes: (value: number) => string;
  tOr: TOr;
}) {
  return (
    <>
      {minutes(filed)}
      {inProgress > 0 ? (
        <span className="tm-field__hint">
          {' '}
          {tOr('TeamTime.inProgress', '+ {time} in progress').replace(
            '{time}',
            minutes(inProgress),
          )}
        </span>
      ) : null}
    </>
  );
}

/** Item 17: where this person's tracking really runs, with the last time it was seen. */
const DEVICE: Readonly<Record<DeviceKind, readonly [string, string, CapsuleState]>> = {
  desktop: ['TeamTime.deviceDesktop', 'Desktop app', 'current'],
  browser_allowed: ['TeamTime.deviceBrowserAllowed', 'Browser, allowed', 'current'],
  browser_prompt: ['TeamTime.deviceBrowserPrompt', 'Browser, not allowed yet', 'waiting'],
  browser_blocked: ['TeamTime.deviceBrowserBlocked', 'Browser, blocked', 'waiting'],
  browser_unsupported: [
    'TeamTime.deviceBrowserUnsupported',
    'Browser that cannot track',
    'waiting',
  ],
};

function DeviceCell({ device, tOr }: { device: TeamPerson['device']; tOr: TOr }) {
  if (device === null) {
    return (
      <StateCapsule state="neutral">{tOr('TeamTime.deviceNone', 'No device seen')}</StateCapsule>
    );
  }
  const [key, english, tone] = DEVICE[device.kind];
  return <StateCapsule state={tone}>{tOr(key, english)}</StateCapsule>;
}

function SessionHow({
  session,
  tOr,
  format,
}: {
  session: TeamSession;
  tOr: TOr;
  format: ReturnType<typeof useDisplayFormatters>;
}) {
  return (
    <>
      {session.source === 'automatic'
        ? tOr('TeamTime.automaticDevice', 'Automatic · reported by their computer')
        : tOr('TeamTime.manual', 'Manual')}
      {session.lateFrom !== null ? (
        <>
          {' '}
          <Badge>
            {tOr('TeamTime.late', 'Late · tracked {day}').replace(
              '{day}',
              format.day(session.lateFrom),
            )}
          </Badge>
        </>
      ) : null}
      {session.needsReview ? (
        <>
          {' '}
          <Badge>{tOr('TeamTime.needsReview', 'Needs review')}</Badge>
        </>
      ) : null}
    </>
  );
}
