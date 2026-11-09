import { ACTIVITY_EVENTS, type ActivityEvent, type ActivitySample } from './ipc';

/**
 * Automatic time tracking (FIX-2026-11-10): the pure half of the desktop activity signal, kept
 * free of Electron so it is unit-tested on its own. `main.ts` reads `powerMonitor` and passes the
 * raw values here; the result is all the renderer ever receives.
 */

/** `powerMonitor.getSystemIdleState` values. */
export type SystemIdleState = 'active' | 'idle' | 'locked' | 'unknown';

/** The sample the renderer gets: whole, non-negative idle seconds and the lock state. */
export function toActivitySample(idleSeconds: number, state: SystemIdleState): ActivitySample {
  const seconds = Number.isFinite(idleSeconds) ? Math.max(0, Math.floor(idleSeconds)) : 0;
  return { idleSeconds: seconds, locked: state === 'locked' };
}

/** `powerMonitor` event names, mapped to the four events the renderer is told about. */
const POWER_EVENTS: Readonly<Record<string, ActivityEvent>> = {
  'lock-screen': 'locked',
  'unlock-screen': 'unlocked',
  suspend: 'suspended',
  resume: 'resumed',
};

export const POWER_MONITOR_EVENTS: readonly string[] = Object.keys(POWER_EVENTS);

export function toActivityEvent(powerEvent: string): ActivityEvent | null {
  return POWER_EVENTS[powerEvent] ?? null;
}

/** Only one of the four known names may cross back to a listener in the renderer. */
export function isActivityEvent(value: unknown): value is ActivityEvent {
  return (ACTIVITY_EVENTS as readonly unknown[]).includes(value);
}
