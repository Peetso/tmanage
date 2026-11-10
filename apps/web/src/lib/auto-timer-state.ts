import type { ActivityStatus } from '@tmanage/domain';
import type { AutoTrackingState } from './api/time-auto';
import type { ActivitySupport } from './activity-sources';

/**
 * FIX-2026-11-10 — what the automatic timer shows. Pure, so every case is unit-tested.
 *
 * - `tracking` — the computer is in use; time is counted.
 * - `paused-idle` / `paused-locked` / `paused-asleep` — counted time stopped at the last input.
 * - `manual` — a manual timer runs; it counts instead.
 * - `needs-permission` — Chrome / Edge must be allowed to detect idle first (one click).
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
  | 'unsupported'
  | 'off';

export function autoTimerDisplay(
  state: AutoTrackingState | undefined,
  support: ActivitySupport,
  permissionGranted: boolean,
  status: ActivityStatus,
): AutoTimerDisplay {
  if (state === undefined || !state.enabled) return 'off';
  if (state.manualTimerRunning) return 'manual';
  if (support === 'unsupported') return 'unsupported';
  if (!permissionGranted) return 'needs-permission';
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

/** The idle thresholds the settings offer, in minutes (the API accepts 1..15). */
export const IDLE_THRESHOLD_CHOICES: readonly number[] = [1, 2, 3, 5, 10, 15];

/** The choices a person has under the owner's maximum (the maximum itself always among them). */
export function idleChoicesUpTo(maxMinutes: number): readonly number[] {
  return [...new Set([...IDLE_THRESHOLD_CHOICES.filter((m) => m <= maxMinutes), maxMinutes])].sort(
    (a, b) => a - b,
  );
}
