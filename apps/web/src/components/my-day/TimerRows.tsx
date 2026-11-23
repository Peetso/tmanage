'use client';

import { useId, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ApiClient } from '../../lib/api/client';
import { readMyTimesheet } from '../../lib/api/finance-core';
import { startTimer } from '../../lib/api/time-timer';
import { getAutoTracking, updateAutoTrackingSettings } from '../../lib/api/time-auto';
import { activitySupport, requestIdleDetection } from '../../lib/activity-sources';
import { isTimerRunningConflict } from '../../lib/timer-state';
import { fill } from '../../lib/privacy-presentation';
import { useT } from '../../lib/i18n/use-t';
import { useTOr } from '../../lib/i18n/use-t-or';
import { StopTimerDialog } from '../time/TimerControls';
import { timerKey, useRunningTimer } from '../time/use-running-timer';
import { autoTrackingKey, useAutoTracker } from '../time/use-auto-tracker';
import { duration, elapsedFace, localDay } from './my-day-format';

/**
 * **Timer** (spec MYDAY-V4 §5): the timer of v3.1 drawn as two rows of the old side column.
 * Row 1: the play orb, the running task (or today's total) over "Today 3 h 20 min", the running
 * time in mono, and Start or Stop. Row 2: "Auto timer" and its switch, while the company allows it.
 * The running state is also the header pill (spec §3.2 rank 9).
 */
export function TimerRows({
  api,
  slug,
  now,
  startOn,
  timedTitle,
}: {
  readonly api: ApiClient;
  readonly slug: string;
  readonly now: number;
  /** The work item Start times: the "Do this next" item when it is a task, else none. */
  readonly startOn: string | null;
  /** The running timer's task name, when the page knows it. */
  readonly timedTitle: (workItemId: string) => string | null;
}) {
  const t = useT();
  const tOr = useTOr();
  const queryClient = useQueryClient();
  const headingId = useId();
  const autoId = useId();
  const { timer, elapsedSeconds, roundingMinutes } = useRunningTimer(api, slug);
  const [stopping, setStopping] = useState(false);
  const sheet = useQuery({
    queryKey: ['finance-timesheet-mine', slug, undefined],
    queryFn: () => readMyTimesheet(api, slug),
    retry: false,
  });
  const today = localDay(now);
  const loggedMinutes = (sheet.data?.groups ?? [])
    .flatMap((group) => group.entries)
    .filter((entry) => entry.spentOn === today)
    .reduce((total, entry) => total + entry.minutes, 0);
  const totalMinutes = loggedMinutes + (timer ? Math.floor(elapsedSeconds / 60) : 0);
  const todayLine =
    totalMinutes > 0
      ? fill(t('MyDay.todayTotal'), { time: duration(tOr, totalMinutes) })
      : t('MyDay.noTimeToday');

  const start = useMutation({
    mutationFn: () => startTimer(api, slug, startOn === null ? {} : { workItemId: startOn }),
    onSettled: async () => {
      await queryClient.invalidateQueries({ queryKey: timerKey(slug) });
    },
  });

  const auto = useQuery({
    queryKey: autoTrackingKey(slug),
    queryFn: () => getAutoTracking(api, slug),
    retry: false,
  });
  const autoSwitch = useMutation({
    mutationFn: async (enabled: boolean) => {
      const view = await updateAutoTrackingSettings(api, slug, { enabled });
      // Chrome and Edge ask once for idle detection; the browser shows its own prompt.
      if (enabled && activitySupport() === 'idle-detector') await requestIdleDetection();
      return view;
    },
    onSuccess: (view) => queryClient.setQueryData(autoTrackingKey(slug), view),
  });
  const policy = auto.data?.policy;
  const title = timer?.workItemId ? timedTitle(timer.workItemId) : null;

  return (
    <section className="tm-home-saved tm-home-timer" aria-labelledby={headingId}>
      <div className="tm-home-saved__head">
        <h2 id={headingId} className="tm-home-saved__heading">
          {t('MyDay.w.timer')}
        </h2>
      </div>
      <ul className="tm-home-saved__list">
        <li className="tm-home-saved__item" data-running={timer ? true : undefined}>
          <span className="tm-home-orb tm-home-timer__orb" aria-hidden="true">
            {timer ? '●' : '▸'}
          </span>
          <span className="tm-home-saved__text">
            <span className="tm-home-saved__title">
              {timer ? (title ?? t('MyDay.timerTask')) : todayLine}
            </span>
            {timer ? <span className="tm-home-timer__today">{todayLine}</span> : null}
          </span>
          {timer ? (
            <span className="tm-meta-mono tm-home-timer__face">
              <bdi dir="ltr">{elapsedFace(elapsedSeconds)}</bdi>
            </span>
          ) : null}
          {timer ? (
            <button
              type="button"
              className="tm-button tm-button--outline tm-button--compact"
              onClick={() => setStopping(true)}
            >
              {t('MyDay.stop')}
            </button>
          ) : (
            <button
              type="button"
              className="tm-button tm-button--outline tm-button--compact"
              disabled={start.isPending}
              onClick={() => start.mutate()}
            >
              {t('MyDay.start')}
            </button>
          )}
        </li>
        {policy !== undefined && policy !== 'off' ? (
          <li className="tm-home-saved__item">
            <label className="tm-home-saved__title tm-home-timer__auto" htmlFor={autoId}>
              {t('MyDay.autoTimer')}
            </label>
            <input
              id={autoId}
              type="checkbox"
              role="switch"
              className="tm-switch"
              checked={auto.data?.enabled ?? false}
              disabled={policy === 'required' || autoSwitch.isPending}
              onChange={(event) => autoSwitch.mutate(event.target.checked)}
            />
          </li>
        ) : null}
      </ul>
      {start.isError && !isTimerRunningConflict(start.error) ? (
        <p className="tm-home-saved__empty" role="alert">
          {t('MyDay.loadFailed')}
        </p>
      ) : null}
      {stopping && timer ? (
        <StopTimerDialog
          api={api}
          organizationSlug={slug}
          initialNote={timer.note ?? ''}
          elapsedSeconds={elapsedSeconds}
          roundingMinutes={roundingMinutes}
          subject={title}
          onClose={() => setStopping(false)}
          tr={tOr}
        />
      ) : null}
    </section>
  );
}

/**
 * Runs the automatic timer's activity tracker while My Day is open; draws nothing. My Day carries
 * the Auto timer as a Timer row instead of the header chip other screens show, so the time is
 * still counted here (it lives in the header, not in the Timer rows a person may hide).
 */
export function AutoTrackerHost({ api, slug }: { readonly api: ApiClient; readonly slug: string }) {
  useAutoTracker(api, slug);
  return null;
}
