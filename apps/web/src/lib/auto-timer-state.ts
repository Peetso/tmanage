import type { ActivityStatus } from '@tmanage/domain';
import type { AutoTrackingState } from './api/time-auto';
import type { ActivitySupport, IdlePermission } from './activity-sources';

/**
 * FIX-2026-11-10 — what the automatic timer shows. Pure, so every case is unit-tested.
 *
 * - `tracking` — the computer is in use; time is counted.
 * - `paused-idle` / `paused-locked` / `paused-asleep` — counted time stopped at the last input.
 * - `manual` — a manual timer runs; it counts instead.
 * - `needs-permission` — Chrome / Edge must be allowed to detect idle first (one click).
 * - `blocked` — the person (or the browser) blocked idle detection for this site (item 12).
 * - `policy-off` — the owner switched automatic tracking off for the company (item 1).
 * - `unsupported` — this browser cannot see whole-computer activity (Firefox, Safari).
 * - `off` — automatic tracking is off for this person.
 */
export type AutoTimerDisplay =
  | 'tracking'
  | 'paused-idle'
  | 'paused-locked'
  | 'paused-asleep'
  | 'manual'
  | 'needs-permission'
  | 'blocked'
  | 'policy-off'
  | 'unsupported'
  | 'off';

export function autoTimerDisplay(
  state: AutoTrackingState | undefined,
  support: ActivitySupport,
  permission: IdlePermission,
  status: ActivityStatus,
): AutoTimerDisplay {
  if (state?.policy === 'off') return 'policy-off';
  if (state === undefined || !state.enabled) return 'off';
  if (state.manualTimerRunning) return 'manual';
  if (support === 'unsupported') return 'unsupported';
  if (permission === 'denied') return 'blocked';
  if (permission === 'prompt') return 'needs-permission';
  switch (status) {
    case 'active':
      return 'tracking';
    case 'locked':
      return 'paused-locked';
    case 'asleep':
      return 'paused-asleep';
    case 'idle':
    case 'off':
      return 'paused-idle';
  }
}

/** Item 14: the owner's "Count someone as away after" choices, every minute from 1 to 15. */
export const AWAY_THRESHOLD_CHOICES: readonly number[] = Array.from(
  { length: 15 },
  (_, i) => i + 1,
);

/** Item 17: what this page reports as the person's tracking device. */
export function deviceKindOf(
  support: ActivitySupport,
  permission: IdlePermission,
): 'desktop' | 'browser_allowed' | 'browser_prompt' | 'browser_blocked' | 'browser_unsupported' {
  if (support === 'desktop') return 'desktop';
  if (support === 'unsupported') return 'browser_unsupported';
  if (permission === 'granted') return 'browser_allowed';
  return permission === 'denied' ? 'browser_blocked' : 'browser_prompt';
}

/**
 * TIMETRACK: the device word this page should report now, or `null` to wait. Nothing is reported
 * before the browser's abilities are known — `null` support or permission means "still checking".
 * Reporting a starting value would tell the owner that a normal Chrome "cannot track", and with the
 * rate limit the correct report a moment later could be refused and never sent.
 */
export function deviceToReport(
  policy: AutoTrackingState['policy'] | undefined,
  support: ActivitySupport | null,
  permission: IdlePermission | null,
): ReturnType<typeof deviceKindOf> | null {
  if (policy === undefined || policy === 'off') return null;
  if (support === null) return null;
  if (support === 'idle-detector' && permission === null) return null;
  return deviceKindOf(support, permission ?? 'prompt');
}

/** Item 15: the one-time "Turn on automatic time tracking" ask, remembered per company. */
export const askedKey = (organizationSlug: string): string =>
  `tm.autotimer.asked.${organizationSlug}`;

/** Item 1: the company used automatic tracking on this computer, so "Off" needs explaining. */
export const usedKey = (organizationSlug: string): string =>
  `tm.autotimer.used.${organizationSlug}`;
