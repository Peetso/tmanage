'use client';

import Link from 'next/link';
import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Button, Field, InlineAlert } from '@tmanage/ui';
import { browserApiClient } from '../../lib/api/browser-client';
import type { ApiClient } from '../../lib/api/client';
import { describeApiErrorNow } from '../../lib/api/describe-error';
import { startTimer, stopTimer } from '../../lib/api/time-timer';
import {
  formatElapsed,
  isTimerRunningConflict,
  minutesToSave,
  timerActionFor,
  TIMER_NOTE_MAX,
} from '../../lib/timer-state';
import { pluralPhrase } from '../../lib/i18n/plural';
import { useActiveLocale } from '../../lib/i18n/use-active-locale';
import { useTOr } from '../../lib/i18n/use-t-or';
import { timerKey, useRunningTimer } from './use-running-timer';
import './timer.css';

type TOr = ReturnType<typeof useTOr>;

/**
 * 52-01 — the timer surfaces (Figma `574:32611`, "R43 L2"): the start/stop button in a work item's
 * header and the running-timer pill in the shell. One running timer per person: starting on
 * another item asks first, and stopping opens a dialog whose note is saved on the time entry.
 */

function TimerDialog({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const titleId = useId();
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    const node = ref.current;
    const first = node?.querySelector<HTMLElement>('input, button');
    (first ?? node)?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      opener?.focus?.();
    };
  }, [onClose]);
  return (
    <div className="tm-timer-scrim">
      <div
        ref={ref}
        className="tm-timer-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
      >
        <h2 id={titleId} className="tm-timer-dialog__title">
          {title}
        </h2>
        {children}
      </div>
    </div>
  );
}

/**
 * Stop the running timer: shows the minutes that will be saved (rounded up to the company's step,
 * and says so) and an editable note.
 */
function StopTimerDialog({
  api,
  organizationSlug,
  initialNote,
  elapsedSeconds,
  roundingMinutes,
  subject,
  onClose,
  tr,
}: {
  api: ApiClient;
  organizationSlug: string;
  initialNote: string;
  elapsedSeconds: number;
  roundingMinutes: number;
  subject: string | null;
  onClose: () => void;
  tr: TOr;
}) {
  const locale = useActiveLocale();
  const queryClient = useQueryClient();
  const [note, setNote] = useState(initialNote);
  const stop = useMutation({
    mutationFn: () => stopTimer(api, organizationSlug, { note: note.trim() }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: timerKey(organizationSlug) });
      await queryClient.invalidateQueries({ queryKey: ['work-items', organizationSlug] });
      onClose();
    },
  });
  const minutes = minutesToSave(elapsedSeconds, roundingMinutes);
  const amount = (
    subject
      ? tr('Timer.stopSummaryOn', '{minutes} min on {subject}').replace('{subject}', subject)
      : tr('Timer.stopSummary', '{minutes} min')
  ).replace('{minutes}', String(minutes));
  const summary =
    roundingMinutes > 1
      ? `${amount} (${pluralPhrase(
          tr,
          locale,
          'Timer.roundedUp',
          roundingMinutes,
          {
            one: 'rounded up to the nearest minute',
            other: 'rounded up to the nearest {count} minutes',
          },
          String(roundingMinutes),
        )})`
      : amount;
  const submit = (event: FormEvent) => {
    event.preventDefault();
    stop.mutate();
  };
  return (
    <TimerDialog title={tr('Timer.stopTitle', 'Stop timer')} onClose={onClose}>
      <form className="tm-timer-dialog__form" onSubmit={submit}>
        <p className="tm-timer-dialog__body">{summary}</p>
        <Field
          label={tr('Timer.noteLabel', 'Note')}
          hint={tr('Timer.noteHint', 'Saved on the time entry. You can change it later.')}
          value={note}
          maxLength={TIMER_NOTE_MAX}
          onChange={(event) => setNote(event.target.value)}
        />
        {stop.isError ? (
          <InlineAlert tone="danger" title={tr('Timer.stopFailed', 'The timer did not stop')} live>
            {describeApiErrorNow(stop.error)}
          </InlineAlert>
        ) : null}
        <div className="tm-timer-dialog__actions">
          <Button type="button" tone="outline" size="compact" onClick={onClose}>
            {tr('Timer.cancel', 'Cancel')}
          </Button>
          <Button
            type="submit"
            tone="ink"
            size="compact"
            loading={stop.isPending}
            loadingLabel={tr('Timer.saving', 'Saving time')}
          >
            {tr('Timer.saveTime', 'Save time')}
          </Button>
        </div>
      </form>
    </TimerDialog>
  );
}

export interface WorkItemTimerButtonProps {
  organizationSlug: string;
  workItemId: string;
  workItemTitle: string;
  client?: ApiClient;
}

/** The work item header's timer: Start, or the ticking time with Stop when this item runs. */
export function WorkItemTimerButton({
  organizationSlug,
  workItemId,
  workItemTitle,
  client,
}: WorkItemTimerButtonProps) {
  const api = client ?? browserApiClient();
  const tr = useTOr();
  const queryClient = useQueryClient();
  const { timer, elapsedSeconds, roundingMinutes } = useRunningTimer(api, organizationSlug);
  const [dialog, setDialog] = useState<'stop' | 'switch' | null>(null);

  const start = useMutation({
    mutationFn: (force: boolean) =>
      startTimer(api, organizationSlug, { workItemId, ...(force ? { force: true } : {}) }),
    onSuccess: async () => {
      setDialog(null);
      await queryClient.invalidateQueries({ queryKey: timerKey(organizationSlug) });
    },
    onError: async (error) => {
      // Another device started a timer since this one last looked: ask before replacing it.
      if (isTimerRunningConflict(error)) {
        await queryClient.invalidateQueries({ queryKey: timerKey(organizationSlug) });
        setDialog('switch');
      }
    },
  });

  const action = timerActionFor(timer, workItemId);
  const onClick = () => {
    if (action === 'start') start.mutate(false);
    else if (action === 'stop') setDialog('stop');
    else setDialog('switch');
  };

  return (
    <>
      {action === 'stop' ? (
        <button
          type="button"
          className="tm-timer-button tm-timer-button--running"
          onClick={onClick}
          aria-label={tr('Timer.stopAria', 'Stop timer, {elapsed} so far').replace(
            '{elapsed}',
            formatElapsed(elapsedSeconds),
          )}
        >
          <span className="tm-timer-dot" aria-hidden="true" />
          <span className="tm-timer-clock" aria-hidden="true">
            {formatElapsed(elapsedSeconds)}
          </span>
          <span aria-hidden="true">{tr('Timer.stop', 'Stop')}</span>
        </button>
      ) : (
        <Button
          tone="outline"
          size="compact"
          onClick={onClick}
          loading={start.isPending}
          loadingLabel={tr('Timer.starting', 'Starting timer')}
        >
          {tr('Timer.start', 'Start timer')}
        </Button>
      )}
      {start.isError && !isTimerRunningConflict(start.error) ? (
        <span className="tm-timer-error" role="alert">
          {tr('Timer.startFailed', 'The timer did not start')}
        </span>
      ) : null}

      {dialog === 'stop' && timer ? (
        <StopTimerDialog
          api={api}
          organizationSlug={organizationSlug}
          initialNote={timer.note ?? ''}
          elapsedSeconds={elapsedSeconds}
          roundingMinutes={roundingMinutes}
          subject={workItemTitle}
          onClose={() => setDialog(null)}
          tr={tr}
        />
      ) : null}

      {dialog === 'switch' ? (
        <TimerDialog
          title={tr('Timer.switchTitle', 'Stop the running timer?')}
          onClose={() => setDialog(null)}
        >
          <p className="tm-timer-dialog__body">
            {tr(
              'Timer.switchBody',
              'Another timer is still running. Stop it, save its time and start this one?',
            )}
          </p>
          {start.isError && !isTimerRunningConflict(start.error) ? (
            <InlineAlert tone="danger" title={tr('Timer.startFailed', 'The timer did not start')}>
              {describeApiErrorNow(start.error)}
            </InlineAlert>
          ) : null}
          <div className="tm-timer-dialog__actions">
            <Button type="button" tone="outline" size="compact" onClick={() => setDialog(null)}>
              {tr('Timer.keepRunning', 'Keep it running')}
            </Button>
            <Button
              type="button"
              tone="ink"
              size="compact"
              loading={start.isPending}
              loadingLabel={tr('Timer.starting', 'Starting timer')}
              onClick={() => start.mutate(true)}
            >
              {tr('Timer.stopAndSwitch', 'Stop and switch')}
            </Button>
          </div>
        </TimerDialog>
      ) : null}
    </>
  );
}

export interface RunningTimerPillProps {
  organizationSlug: string;
  client?: ApiClient;
}

/** The shell's pill while a timer runs: elapsed time, a link to the item, and Stop. */
export function RunningTimerPill({ organizationSlug, client }: RunningTimerPillProps) {
  const api = client ?? browserApiClient();
  const tr = useTOr();
  const { timer, elapsedSeconds, roundingMinutes } = useRunningTimer(api, organizationSlug);
  const [stopping, setStopping] = useState(false);
  // Read on each render (the pill re-renders every second), so a client navigation is seen.
  const pathname = typeof window === 'undefined' ? '' : window.location.pathname;
  if (timer === null) return null;
  // Item 6: on the timed item's own page its Stop button is right there; one Stop is enough.
  if (
    timer.workItemId !== null &&
    pathname.endsWith(`/work/${encodeURIComponent(timer.workItemId)}`) &&
    !stopping
  ) {
    return null;
  }
  const elapsed = formatElapsed(elapsedSeconds);
  const label = tr('Timer.running', 'Timer running');
  return (
    <>
      <span className="tm-timer-pill" role="group" aria-label={label}>
        <span className="tm-timer-dot" aria-hidden="true" />
        {timer.workItemId ? (
          <Link
            className="tm-timer-pill__link"
            href={`/${organizationSlug}/work/${encodeURIComponent(timer.workItemId)}`}
            aria-label={tr('Timer.openItem', 'Open the timed work item, {elapsed}').replace(
              '{elapsed}',
              elapsed,
            )}
          >
            <span className="tm-timer-clock">{elapsed}</span>
          </Link>
        ) : (
          <span className="tm-timer-clock">{elapsed}</span>
        )}
        <button type="button" className="tm-timer-pill__stop" onClick={() => setStopping(true)}>
          {tr('Timer.stop', 'Stop')}
        </button>
      </span>
      {stopping ? (
        <StopTimerDialog
          api={api}
          organizationSlug={organizationSlug}
          initialNote={timer.note ?? ''}
          elapsedSeconds={elapsedSeconds}
          roundingMinutes={roundingMinutes}
          subject={null}
          onClose={() => setStopping(false)}
          tr={tr}
        />
      ) : null}
    </>
  );
}
