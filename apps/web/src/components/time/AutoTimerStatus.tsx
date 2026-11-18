'use client';

import { useEffect, useId, useRef, useState } from 'react';
import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, InlineAlert, Switch, Tooltip } from '@tmanage/ui';
import { browserApiClient } from '../../lib/api/browser-client';
import type { ApiClient } from '../../lib/api/client';
import { describeApiErrorNow } from '../../lib/api/describe-error';
import {
  getAutoTracking,
  setCurrentTask,
  updateAutoTrackingSettings,
} from '../../lib/api/time-auto';
import type { AutoTrackingState } from '../../lib/api/time-auto';
import type { ActivitySupport } from '../../lib/activity-sources';
import {
  askedKey,
  autoTimerDisplay,
  usedKey,
  type AutoTimerDisplay,
} from '../../lib/auto-timer-state';
import { pluralPhrase } from '../../lib/i18n/plural';
import { useActiveLocale } from '../../lib/i18n/use-active-locale';
import { useTOr } from '../../lib/i18n/use-t-or';
import { pricingSurveyQuery } from '../screens/pricing-survey-query';
import { desktopStartup, type DesktopStartupState } from './desktop-startup';
import { autoTrackingKey, useAutoTracker } from './use-auto-tracker';
import { timerQuery } from './use-running-timer';
import './timer.css';

type TOr = ReturnType<typeof useTOr>;

/**
 * FIX-2026-11-10 — the automatic timer in the shell (Peter: "the timer automatic starts when the
 * pc is active ... and stops when it's not active, not the page i mean the whole pc").
 *
 * A short status chip (its full meaning in the hover help) and a panel. The live check fixes of
 * 2026-11-14: the chip stays, as "Off", when the owner switched tracking off (item 1); it never
 * wraps the header (item 6); a blocked browser permission is detected and explained (item 12);
 * "On for everyone" has no personal switch (item 13); the pause threshold is the workspace's
 * (item 14); and the browser's one-time Allow is asked once, as one button (item 15).
 */

/** Short chip labels: one or two words, so the header row never wraps (item 6). */
const SHORT: Readonly<Record<AutoTimerDisplay, readonly [string, string]>> = {
  tracking: ['AutoTimer.short.tracking', 'Tracking'],
  'paused-idle': ['AutoTimer.short.paused', 'Paused'],
  'paused-locked': ['AutoTimer.short.paused', 'Paused'],
  'paused-asleep': ['AutoTimer.short.paused', 'Paused'],
  manual: ['AutoTimer.short.manual', 'Manual timer'],
  'needs-permission': ['AutoTimer.short.needsOk', 'Needs your OK'],
  blocked: ['AutoTimer.short.blocked', 'Blocked'],
  'policy-off': ['AutoTimer.short.off', 'Off'],
  unsupported: ['AutoTimer.short.unavailable', 'Timer only'],
  off: ['AutoTimer.short.off', 'Off'],
};

const LABEL: Readonly<Record<AutoTimerDisplay, readonly [string, string]>> = {
  tracking: ['AutoTimer.state.tracking', 'Tracking'],
  'paused-idle': ['AutoTimer.state.pausedIdle', 'Paused, computer idle'],
  'paused-locked': ['AutoTimer.state.pausedLocked', 'Paused, screen locked'],
  'paused-asleep': ['AutoTimer.state.pausedAsleep', 'Paused, computer asleep'],
  manual: ['AutoTimer.state.manual', 'Manual timer running'],
  'needs-permission': ['AutoTimer.state.needsPermission', 'Off, needs your permission'],
  blocked: ['AutoTimer.state.blocked', 'Off, blocked in your browser'],
  'policy-off': ['AutoTimer.state.policyOff', 'Off for the whole workspace'],
  unsupported: ['AutoTimer.state.unsupported', 'Off in this browser · the timer still works'],
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
  blocked: [
    'AutoTimer.help.blocked',
    'Your browser blocked activity detection for TManage. Open the timer to see how to allow it.',
  ],
  'policy-off': [
    'AutoTimer.help.policyOff',
    'Your workspace owner switched automatic tracking off. Time counted before that was saved up to your last activity.',
  ],
  unsupported: [
    'AutoTimer.help.unsupported',
    'The timer works here. Automatic tracking needs the TManage desktop app, or Chrome or Edge on a computer.',
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
  blocked: 'off',
  'policy-off': 'off',
  unsupported: 'off',
  off: 'off',
};

function readFlag(key: string): boolean {
  try {
    return window.localStorage.getItem(key) === '1';
  } catch {
    return false;
  }
}

function writeFlag(key: string): void {
  try {
    window.localStorage.setItem(key, '1');
  } catch {
    // Private mode: the ask may show again next visit, nothing worse.
  }
}

/** Whether the one-click "Turn on automatic time tracking" applies (item 15). */
function needsTurnOn(state: AutoTrackingState, display: AutoTimerDisplay): boolean {
  if (display === 'needs-permission') return true;
  return display === 'off' && state.policy === 'optional';
}

/**
 * UX test 2026-11-15 (bug 2): the panel opens by itself only on the home page, never over a form
 * someone is filling in on another page.
 */
function onHomePage(organizationSlug: string): boolean {
  if (typeof window === 'undefined') return false;
  const path = window.location.pathname.replace(/\/+$/, '');
  const base = `/${encodeURIComponent(organizationSlug)}`;
  return path === base || path === `${base}/home`;
}

export interface AutoTimerStatusProps {
  organizationSlug: string;
  client?: ApiClient;
}

export function AutoTimerStatus({ organizationSlug, client }: AutoTimerStatusProps) {
  const api = client ?? browserApiClient();
  const tr = useTOr();
  const tracker = useAutoTracker(api, organizationSlug);
  const [open, setOpen] = useState(false);
  const [used, setUsed] = useState(false);
  const panelId = useId();
  const wrapper = useRef<HTMLDivElement>(null);
  const chipRef = useRef<HTMLButtonElement>(null);
  const refocus = useRef(false);
  const state = tracker.state;
  // UX test T-P2-5: while a manual timer runs, its pill is the one state in the header.
  const manualRunning = useQuery(timerQuery(api, organizationSlug)).data?.state?.timer != null;
  const display =
    state === undefined
      ? 'off'
      : autoTimerDisplay(state, tracker.support, tracker.permission, tracker.status);

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      // UX test item 7: Escape hands focus back to the chip (focused after it re-renders).
      refocus.current = true;
      setOpen(false);
    };
    const onPointer = (event: PointerEvent) => {
      const target = event.target;
      if (wrapper.current && target instanceof Node && !wrapper.current.contains(target)) {
        setOpen(false);
      }
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onPointer);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onPointer);
    };
  }, [open]);

  useEffect(() => {
    if (open || !refocus.current) return;
    refocus.current = false;
    chipRef.current?.focus();
  }, [open]);

  // Item 1: remember that this company used the automatic timer here, so "Off" is explained.
  const policy = state?.policy;
  useEffect(() => {
    if (policy === undefined) return;
    if (policy !== 'off') writeFlag(usedKey(organizationSlug));
    setUsed(readFlag(usedKey(organizationSlug)));
  }, [policy, organizationSlug]);

  // Item 15: open the panel by itself once, at the first visit where tracking applies.
  const ask = state !== undefined && needsTurnOn(state, display) && display !== 'unsupported';
  const autoOpen = ask && onHomePage(organizationSlug);
  // 57-17: Home asks one question at a time. While its "what would you pay" card is up, the panel
  // keeps its first-visit opening for a later visit instead of covering the card.
  const survey = useQuery({ ...pricingSurveyQuery(api, organizationSlug), enabled: autoOpen });
  const surveyShown = survey.data?.show === true;
  // Once the card was up on this visit, the panel waits even after it is answered or skipped.
  const surveyAsked = useRef(false);
  useEffect(() => {
    if (!autoOpen || survey.isPending) return;
    if (surveyShown) surveyAsked.current = true;
    if (surveyAsked.current || readFlag(askedKey(organizationSlug))) return;
    writeFlag(askedKey(organizationSlug));
    setOpen(true);
  }, [autoOpen, survey.isPending, surveyShown, organizationSlug]);

  // TIMETRACK: say nothing about this browser until its abilities are known (no false flash).
  if (!tracker.available || state === undefined || !tracker.detected) return null;
  if (state.policy === 'off' && !used) return null;
  if (manualRunning && !open) return null;
  const [shortKey, shortEnglish] = SHORT[display];
  const [labelKey, labelEnglish] = LABEL[display];
  const [helpKey, helpEnglish] = HELP[display];
  const chip = (
    <button
      ref={chipRef}
      type="button"
      className="tm-autotimer__chip"
      data-tone={TONE[display]}
      aria-expanded={open}
      aria-controls={panelId}
      aria-label={`${tr('AutoTimer.name', 'Auto timer')}: ${tr(labelKey, labelEnglish)}`}
      onClick={() => setOpen((value) => !value)}
    >
      <span className="tm-autotimer__dot" aria-hidden="true" />
      <span className="tm-autotimer__name">{tr('AutoTimer.name', 'Auto timer')}</span>
      <span className="tm-autotimer__state">{tr(shortKey, shortEnglish)}</span>
    </button>
  );

  return (
    <div className="tm-autotimer" ref={wrapper}>
      {/* Item 6: the hover help carries the full text; it stays out of the way of the panel. */}
      {open ? (
        chip
      ) : (
        <Tooltip
          content={`${tr(labelKey, labelEnglish)}. ${tr(helpKey, helpEnglish)}`}
          delayMs={600}
        >
          {chip}
        </Tooltip>
      )}
      {open ? (
        <AutoTimerPanel
          id={panelId}
          api={api}
          organizationSlug={organizationSlug}
          state={state}
          display={display}
          support={tracker.support}
          onAllow={tracker.requestPermission}
          tr={tr}
        />
      ) : null}
    </div>
  );
}

function AutoTimerPanel(props: AutoTimerPanelProps) {
  const holder = useRef<HTMLDivElement>(null);
  // UX test item 7: the panel takes focus when it opens, so keyboard users land inside it.
  useEffect(() => {
    holder.current?.focus();
  }, []);
  return (
    <div
      ref={holder}
      tabIndex={-1}
      className="tm-autotimer__holder"
      aria-label={props.tr('AutoTimer.panelTitle', 'Automatic timer')}
      role="group"
    >
      <AutoTimerPanelBody {...props} />
    </div>
  );
}

interface AutoTimerPanelProps {
  id: string;
  api: ApiClient;
  organizationSlug: string;
  state: AutoTrackingState;
  display: AutoTimerDisplay;
  support: ActivitySupport;
  onAllow: () => Promise<void>;
  tr: TOr;
}

function AutoTimerPanelBody({
  id,
  api,
  organizationSlug,
  state,
  display,
  support,
  onAllow,
  tr,
}: AutoTimerPanelProps) {
  const queryClient = useQueryClient();
  const titleId = useId();
  const locale = useActiveLocale();
  const key = autoTrackingKey(organizationSlug);
  const settings = useMutation({
    mutationFn: (enabled: boolean) =>
      updateAutoTrackingSettings(api, organizationSlug, { enabled }),
    onSuccess: (view) => queryClient.setQueryData(key, view),
  });
  const clearTask = useMutation({
    mutationFn: () => setCurrentTask(api, organizationSlug, null),
    onSuccess: (view) => queryClient.setQueryData(key, view),
  });
  const required = state.policy === 'required';

  // One click does all of it: switch tracking on (where the person chooses) and ask the browser.
  const turnOn = async () => {
    if (!state.enabled && state.policy === 'optional') await settings.mutateAsync(true);
    if (support === 'idle-detector') await onAllow();
  };

  if (display === 'policy-off') {
    return (
      <section id={id} className="tm-autotimer__panel" aria-labelledby={titleId}>
        <h2 id={titleId} className="tm-autotimer__title">
          {tr('AutoTimer.panelTitle', 'Automatic timer')}
        </h2>
        <p>
          {tr(
            'AutoTimer.policyOffBody',
            'Your workspace owner switched automatic tracking off. Time counted before that was saved up to your last activity, and you find it in your timesheet.',
          )}
        </p>
        <p className="tm-autotimer__muted">
          {tr('AutoTimer.policyOffManual', 'You can still use the manual timer on any task.')}
        </p>
      </section>
    );
  }

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

      {/* Item 13: "On for everyone" has no personal switch; "Each person chooses" has one. */}
      {required ? (
        <p className="tm-autotimer__muted">
          {tr(
            'AutoTimer.requiredLine',
            'Your workspace owner turned this on for everyone. It starts by itself when you are signed in.',
          )}
        </p>
      ) : (
        <Switch
          label={tr('AutoTimer.switchLabel', 'Track my time automatically')}
          checked={state.enabled}
          disabled={settings.isPending}
          onChange={(event) => settings.mutate(event.target.checked)}
        />
      )}

      {/* Item 14: one line, the workspace's threshold; nothing to set here. */}
      <p className="tm-autotimer__muted">
        {pluralPhrase(tr, locale, 'AutoTimer.pausesAfter', state.idleThresholdMinutes, {
          one: 'It pauses by itself after {count} minute without keyboard or mouse use, and continues when you are back.',
          other:
            'It pauses by itself after {count} minutes without keyboard or mouse use, and continues when you are back.',
        })}
      </p>

      {settings.isError ? (
        <InlineAlert tone="danger" title={tr('AutoTimer.saveFailed', 'Not saved')} live>
          {describeApiErrorNow(settings.error)}
        </InlineAlert>
      ) : null}

      {display === 'unsupported' ? (
        // TIMETRACK: what works comes first; only the optional automatic part needs more.
        <InlineAlert tone="neutral">
          {tr(
            'AutoTimer.unsupported',
            'The timer works here. Automatic tracking needs to know when your computer is in use, and this browser cannot tell. For that, use the TManage desktop app, or Chrome or Edge on a computer.',
          )}{' '}
          <Link href="/download">{tr('AutoTimer.getApp', 'Get the desktop app')}</Link>
        </InlineAlert>
      ) : null}

      {/* Item 15: one button, one sentence of why. */}
      {needsTurnOn(state, display) ? (
        <div className="tm-autotimer__allow">
          <p>
            {support === 'idle-detector'
              ? tr(
                  'AutoTimer.turnOnWhy',
                  'Your browser asks once whether TManage may know when your computer is in use, so your time counts without you starting anything.',
                )
              : tr(
                  'AutoTimer.turnOnWhyDesktop',
                  'Your time then counts while you use your computer, without you starting anything.',
                )}
          </p>
          <Button
            type="button"
            tone="ink"
            size="compact"
            loading={settings.isPending}
            loadingLabel={tr('AutoTimer.choosing', 'Saving')}
            onClick={() => void turnOn().catch(() => undefined)}
          >
            {tr('AutoTimer.turnOn', 'Turn on automatic time tracking')}
          </Button>
        </div>
      ) : null}

      {/* Item 12: the browser blocked it; say exactly what to click. */}
      {display === 'blocked' ? (
        <InlineAlert tone="warning" title={tr('AutoTimer.blockedTitle', 'Blocked in your browser')}>
          <p>
            {tr(
              'AutoTimer.blockedSteps',
              'Click the lock icon to the left of the web address, set "Idle detection" to Allow, then reload this page.',
            )}
          </p>
          <Button
            type="button"
            tone="outline"
            size="compact"
            onClick={() => window.location.reload()}
          >
            {tr('AutoTimer.reload', 'Reload page')}
          </Button>
        </InlineAlert>
      ) : null}

      {support === 'desktop' ? <DesktopStartupSwitch tr={tr} /> : null}

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
              'AutoTimer.noTaskButton',
              'No task chosen. Your time is kept as unassigned time. In your timesheet you can put it on a task, split it or delete it. To choose a task now, open it and press "{button}".',
            ).replace('{button}', tr('AutoTimer.workOnThis', 'Work on this now'))}
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

/** Item 16: the desktop app's "Start TManage with my computer", visible and the person's own. */
function DesktopStartupSwitch({ tr }: { tr: TOr }) {
  const [startup, setStartup] = useState<DesktopStartupState | null>(null);
  useEffect(() => {
    let live = true;
    void desktopStartup()
      ?.get()
      .then((found) => {
        if (live) setStartup(found);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);
  if (startup === null) return null;
  return (
    <Switch
      label={tr('AutoTimer.startWithComputer', 'Start TManage with my computer')}
      hint={tr(
        'AutoTimer.startWithComputerHint',
        'TManage opens in the tray when you sign in to your computer, so tracking starts by itself.',
      )}
      checked={startup.openAtLogin}
      onChange={(event) => {
        void desktopStartup()
          ?.set(event.target.checked)
          .then(setStartup)
          .catch(() => undefined);
      }}
    />
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
  if (state === undefined || !state.enabled || state.policy === 'off') return null;
  const current = state.currentTask?.workItemId === workItemId;
  return (
    <>
      <Tooltip
        content={
          current
            ? tr(
                'AutoTimer.workingOnThisHelp',
                'Your automatic time goes to this task. Press to stop: time from then on stays unassigned.',
              )
            : tr(
                'AutoTimer.workOnThisHelp',
                'Your automatic time goes to this task from now on. Time before stays where it was.',
              )
        }
        delayMs={600}
      >
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
      </Tooltip>
      {choose.isError ? (
        <span className="tm-timer-error" role="alert">
          {describeApiErrorNow(choose.error)}
        </span>
      ) : null}
    </>
  );
}
