'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, InlineAlert, Select, Switch, Tooltip } from '@tmanage/ui';
import { browserApiClient } from '../../lib/api/browser-client';
import type { ApiClient } from '../../lib/api/client';
import { describeApiErrorNow } from '../../lib/api/describe-error';
import {
  getAutoTracking,
  setCurrentTask,
  updateAutoTrackingSettings,
} from '../../lib/api/time-auto';
import type { AutoTrackingState } from '../../lib/api/time-auto';
import {
  IDLE_THRESHOLD_CHOICES,
  autoTimerDisplay,
  type AutoTimerDisplay,
} from '../../lib/auto-timer-state';
import { useDisplayFormatters } from '../../lib/i18n/use-formatters';
import { useTOr } from '../../lib/i18n/use-t-or';
import { autoTrackingKey, useAutoTracker } from './use-auto-tracker';
import './timer.css';

type TOr = ReturnType<typeof useTOr>;

/**
 * FIX-2026-11-10 — the automatic timer in the shell (Peter: "the timer automatic starts when the
 * pc is active ... and stops when it's not active, not the page i mean the whole pc").
 *
 * A status chip with hover help (Tracking / Paused, computer idle / Off), and a panel with the
 * person's own switch, idle threshold, current task, the privacy line and who can see their time.
 * The tracker itself runs in `useAutoTracker`; the API decides every start and end.
 */

const LABEL: Readonly<Record<AutoTimerDisplay, readonly [string, string]>> = {
  tracking: ['AutoTimer.state.tracking', 'Tracking'],
  'paused-idle': ['AutoTimer.state.pausedIdle', 'Paused, computer idle'],
  'paused-locked': ['AutoTimer.state.pausedLocked', 'Paused, screen locked'],
  'paused-asleep': ['AutoTimer.state.pausedAsleep', 'Paused, computer asleep'],
  manual: ['AutoTimer.state.manual', 'Manual timer running'],
  'needs-permission': ['AutoTimer.state.needsPermission', 'Off, needs your permission'],
  unsupported: ['AutoTimer.state.unsupported', 'Off, not available in this browser'],
  off: ['AutoTimer.state.off', 'Off'],
};

const HELP: Readonly<Record<AutoTimerDisplay, readonly [string, string]>> = {
  tracking: [
    'AutoTimer.help.tracking',
    'Your computer is in use, so your time is being counted. It pauses by itself when you step away.',
  ],
  'paused-idle': [
    'AutoTimer.help.pausedIdle',
    'No keyboard or mouse use for a while, so counting stopped at your last activity. It starts again when you come back.',
  ],
  'paused-locked': [
    'AutoTimer.help.pausedLocked',
    'Your screen is locked, so counting stopped. It starts again when you unlock and work.',
  ],
  'paused-asleep': [
    'AutoTimer.help.pausedAsleep',
    'Your computer was asleep, so counting stopped. It starts again when you work.',
  ],
  manual: [
    'AutoTimer.help.manual',
    'A manual timer is running and counts this time, so the automatic timer waits until you stop it.',
  ],
  'needs-permission': [
    'AutoTimer.help.needsPermission',
    'Your browser asks once before TManage can tell whether your computer is in use. Open the timer to allow it.',
  ],
  unsupported: [
    'AutoTimer.help.unsupported',
    'This browser cannot tell whether your computer is in use. Use the TManage desktop app, or Chrome or Edge.',
  ],
  off: ['AutoTimer.help.off', 'Automatic tracking is off. Open the timer to turn it on.'],
};

const TONE: Readonly<Record<AutoTimerDisplay, 'on' | 'paused' | 'off'>> = {
  tracking: 'on',
  'paused-idle': 'paused',
  'paused-locked': 'paused',
  'paused-asleep': 'paused',
  manual: 'on',
  'needs-permission': 'off',
  unsupported: 'off',
  off: 'off',
};

export interface AutoTimerStatusProps {
  organizationSlug: string;
  client?: ApiClient;
}

export function AutoTimerStatus({ organizationSlug, client }: AutoTimerStatusProps) {
  const api = client ?? browserApiClient();
  const tr = useTOr();
  const tracker = useAutoTracker(api, organizationSlug);
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const wrapper = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    const onPointer = (event: PointerEvent) => {
      if (wrapper.current && !wrapper.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onPointer);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onPointer);
    };
  }, [open]);

  const state = tracker.state;
  if (!tracker.available || state === undefined || state.policy === 'off') return null;
  const display = autoTimerDisplay(
    state,
    tracker.support,
    tracker.permissionGranted,
    tracker.status,
  );
  const [labelKey, labelEnglish] = LABEL[display];
  const [helpKey, helpEnglish] = HELP[display];

  return (
    <div className="tm-autotimer" ref={wrapper}>
      <Tooltip content={tr(helpKey, helpEnglish)} delayMs={600}>
        <button
          type="button"
          className="tm-autotimer__chip"
          data-tone={TONE[display]}
          aria-expanded={open}
          aria-controls={panelId}
          onClick={() => setOpen((value) => !value)}
        >
          <span className="tm-autotimer__dot" aria-hidden="true" />
          <span className="tm-autotimer__name">{tr('AutoTimer.name', 'Auto timer')}</span>
          <span className="tm-autotimer__state">{tr(labelKey, labelEnglish)}</span>
        </button>
      </Tooltip>
      {open ? (
        <AutoTimerPanel
          id={panelId}
          api={api}
          organizationSlug={organizationSlug}
          state={state}
          display={display}
          onAllow={tracker.requestPermission}
          tr={tr}
        />
      ) : null}
    </div>
  );
}

function AutoTimerPanel({
  id,
  api,
  organizationSlug,
  state,
  display,
  onAllow,
  tr,
}: {
  id: string;
  api: ApiClient;
  organizationSlug: string;
  state: AutoTrackingState;
  display: AutoTimerDisplay;
  onAllow: () => Promise<void>;
  tr: TOr;
}) {
  const queryClient = useQueryClient();
  const titleId = useId();
  const key = autoTrackingKey(organizationSlug);
  const format = useDisplayFormatters();
  const settings = useMutation({
    mutationFn: (input: { enabled: boolean; idleThresholdMinutes: number }) =>
      updateAutoTrackingSettings(api, organizationSlug, input),
    onSuccess: (view) => queryClient.setQueryData(key, view),
  });
  const clearTask = useMutation({
    mutationFn: () => setCurrentTask(api, organizationSlug, null),
    onSuccess: (view) => queryClient.setQueryData(key, view),
  });
  const required = state.policy === 'required';

  return (
    <section id={id} className="tm-autotimer__panel" aria-labelledby={titleId}>
      <h2 id={titleId} className="tm-autotimer__title">
        {tr('AutoTimer.panelTitle', 'Automatic timer')}
      </h2>
      <p className="tm-autotimer__intro">
        {tr(
          'AutoTimer.intro',
          'Counts your time while you use your computer, in any app, and pauses when you step away or lock the screen. No need to start or stop it.',
        )}
      </p>

      <Switch
        label={tr('AutoTimer.switchLabel', 'Track my time automatically')}
        hint={
          required
            ? tr('AutoTimer.requiredHint', 'Your company owner turned this on for everyone.')
            : undefined
        }
        checked={state.enabled}
        disabled={required || settings.isPending}
        onChange={(event) =>
          settings.mutate({
            enabled: event.target.checked,
            idleThresholdMinutes: state.idleThresholdMinutes,
          })
        }
      />

      <Select
        label={tr('AutoTimer.thresholdLabel', 'Pause after no activity for')}
        hint={tr(
          'AutoTimer.thresholdHint',
          'The idle minutes are never counted: time stops at your last keyboard or mouse use.',
        )}
        value={String(state.idleThresholdMinutes)}
        disabled={settings.isPending}
        onChange={(event) =>
          settings.mutate({
            enabled: state.ownSwitch,
            idleThresholdMinutes: Number(event.target.value),
          })
        }
      >
        {IDLE_THRESHOLD_CHOICES.map((minutes) => (
          <option key={minutes} value={minutes}>
            {tr('AutoTimer.minutes', '{n} min').replace('{n}', format.number(minutes))}
          </option>
        ))}
      </Select>

      {settings.isError ? (
        <InlineAlert tone="danger" title={tr('AutoTimer.saveFailed', 'Not saved')} live>
          {describeApiErrorNow(settings.error)}
        </InlineAlert>
      ) : null}

      {display === 'unsupported' ? (
        <InlineAlert tone="warning">
          {tr(
            'AutoTimer.unsupported',
            'This browser cannot tell whether your computer is in use, so it cannot track your time automatically. Use the TManage desktop app, or open TManage in Chrome or Edge.',
          )}
        </InlineAlert>
      ) : null}
      {display === 'needs-permission' ? (
        <div className="tm-autotimer__allow">
          <p>
            {tr(
              'AutoTimer.permissionBody',
              'Your browser will ask once whether TManage may know when your computer is in use or locked. Keep a TManage tab open while you work.',
            )}
          </p>
          <Button type="button" tone="ink" size="compact" onClick={() => void onAllow()}>
            {tr('AutoTimer.allow', 'Allow activity detection')}
          </Button>
        </div>
      ) : null}

      <div className="tm-autotimer__task">
        <h3 className="tm-autotimer__subtitle">{tr('AutoTimer.taskTitle', 'Working on now')}</h3>
        {state.currentTask !== null ? (
          <p>
            {state.currentTask.title ?? tr('AutoTimer.taskHidden', 'A task you can no longer open')}{' '}
            <Button
              type="button"
              tone="outline"
              size="compact"
              loading={clearTask.isPending}
              loadingLabel={tr('AutoTimer.clearing', 'Clearing')}
              onClick={() => clearTask.mutate()}
            >
              {tr('AutoTimer.clearTask', 'Clear')}
            </Button>
          </p>
        ) : (
          <p className="tm-autotimer__muted">
            {tr(
              'AutoTimer.noTask',
              'No task chosen. Your time is kept as unassigned work time, and you can file it under a task later in your timesheet. To choose one, open a task and press "Work on this now".',
            )}
          </p>
        )}
      </div>

      <p className="tm-autotimer__privacy">
        {tr(
          'AutoTimer.privacy',
          'Only whether you are active or idle, and the times, are recorded. No screenshots, keystrokes, app or window names, or web addresses.',
        )}
      </p>
      <p className="tm-autotimer__privacy">
        {tr(
          'AutoTimer.visibility',
          'Your tracked time and current task are visible to your workspace owner and admins, and to people they authorize.',
        )}
      </p>
    </section>
  );
}

export interface CurrentTaskButtonProps {
  organizationSlug: string;
  workItemId: string;
  client?: ApiClient;
}

/** A work item's "Work on this now": automatic time goes to this task from now on. */
export function CurrentTaskButton({
  organizationSlug,
  workItemId,
  client,
}: CurrentTaskButtonProps) {
  const api = client ?? browserApiClient();
  const tr = useTOr();
  const queryClient = useQueryClient();
  const key = autoTrackingKey(organizationSlug);
  const state = useQuery({
    queryKey: key,
    queryFn: () => getAutoTracking(api, organizationSlug),
    staleTime: 60_000,
    retry: false,
  }).data;
  const choose = useMutation({
    mutationFn: (next: string | null) => setCurrentTask(api, organizationSlug, next),
    onSuccess: (view) => queryClient.setQueryData(key, view),
  });
  if (state === undefined || !state.enabled) return null;
  const current = state.currentTask?.workItemId === workItemId;
  return (
    <>
      <Button
        tone="outline"
        size="compact"
        aria-pressed={current}
        loading={choose.isPending}
        loadingLabel={tr('AutoTimer.choosing', 'Saving')}
        onClick={() => choose.mutate(current ? null : workItemId)}
      >
        {current
          ? tr('AutoTimer.workingOnThis', 'Working on this')
          : tr('AutoTimer.workOnThis', 'Work on this now')}
      </Button>
      {choose.isError ? (
        <span className="tm-timer-error" role="alert">
          {describeApiErrorNow(choose.error)}
        </span>
      ) : null}
    </>
  );
}
