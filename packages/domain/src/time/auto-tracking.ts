/**
 * FIX-2026-11-10 — automatic time tracking: the rules the web app, the desktop app and the API
 * share.
 *
 * The timer runs while the person is using the computer (any app, not only the TManage tab) and
 * pauses when the computer is idle, locked or asleep. Two signal sources feed the same tracker:
 *
 * - the desktop app (Electron `powerMonitor`: seconds since the last keyboard or mouse input
 *   anywhere on the computer, plus lock / unlock / suspend / resume events);
 * - Chrome and Edge through the Idle Detection API (system-wide idle and screen lock, while a
 *   TManage tab is open).
 *
 * Only the state and times leave the device: no screenshots, keystrokes, app or window names, or
 * URLs. The tracker below decides, from those signals alone, when to send a heartbeat. A heartbeat
 * carries one number, `idleSeconds` (how long ago the last input was); the server stamps its own
 * clock and joins heartbeats into sessions (`apps/api/src/modules/time/time-auto-rules.ts`), so the
 * client never sends a time, a duration or a person.
 *
 * Idle trimming: when the idle threshold passes, the tracker sends one last heartbeat whose
 * `idleSeconds` says how long the computer has been idle. The server ends the session at
 * `server now - idleSeconds`, the last moment of real activity, so idle minutes are never counted.
 */

/** The company owner's choice: nobody tracks automatically, each person chooses, or everybody. */
export const AUTO_TRACKING_POLICIES = ['off', 'optional', 'required'] as const;
export type AutoTrackingPolicy = (typeof AUTO_TRACKING_POLICIES)[number];
export const DEFAULT_AUTO_TRACKING_POLICY: AutoTrackingPolicy = 'optional';

export function isAutoTrackingPolicy(value: unknown): value is AutoTrackingPolicy {
  return (AUTO_TRACKING_POLICIES as readonly unknown[]).includes(value);
}

/**
 * When someone counts as away, in whole minutes: one workspace setting the company owner chooses
 * ("Count someone as away after", default {@link IDLE_THRESHOLD_DEFAULT_MINUTES}, 1 to
 * {@link IDLE_THRESHOLD_MAX_MINUTES}). There is no personal choice (Peter, 2026-11-10).
 */
export const IDLE_THRESHOLD_MIN_MINUTES = 1;
export const IDLE_THRESHOLD_MAX_MINUTES = 15;
export const IDLE_THRESHOLD_DEFAULT_MINUTES = 5;

/**
 * TIMER item 17: where a person's tracking runs, as their page reports it — the desktop app, or a
 * browser whose idle-detection permission is allowed, not asked yet, blocked, or missing. The one
 * schema of `PUT time/auto/device`: the API parses with it and the web builds its body from it.
 */
export const TRACKING_DEVICE_KINDS = [
  'desktop',
  'browser_allowed',
  'browser_prompt',
  'browser_blocked',
  'browser_unsupported',
] as const;
export type TrackingDeviceKind = (typeof TRACKING_DEVICE_KINDS)[number];

/** The body of `PUT time/auto/device`. */
export interface TrackingDeviceReport {
  readonly device: TrackingDeviceKind;
}

export function isTrackingDeviceKind(value: unknown): value is TrackingDeviceKind {
  return (TRACKING_DEVICE_KINDS as readonly unknown[]).includes(value);
}

/** The report, or null when the body is not exactly `{ device: <kind> }`. */
export function parseTrackingDeviceReport(body: unknown): TrackingDeviceReport | null {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return null;
  const keys = Object.keys(body);
  if (keys.length !== 1 || keys[0] !== 'device') return null;
  const device: unknown = (body as { readonly device?: unknown }).device;
  return isTrackingDeviceKind(device) ? { device } : null;
}

/**
 * Automatic time is reported by the person's own device, so the server bounds it: at most
 * {@link AUTO_DAY_CAP_MINUTES} a person per local day, and a day above
 * {@link AUTO_DAY_REVIEW_MINUTES} or a session above {@link AUTO_SESSION_REVIEW_MINUTES} without a
 * break is flagged for review.
 */
export const AUTO_DAY_CAP_MINUTES = 16 * 60;
export const AUTO_DAY_REVIEW_MINUTES = 12 * 60;
export const AUTO_SESSION_REVIEW_MINUTES = 6 * 60;

/** How often the client reads the idle state. */
export const ACTIVITY_SAMPLE_SECONDS = 15;
/** How often an active client sends a heartbeat. */
export const ACTIVITY_HEARTBEAT_SECONDS = 60;
/**
 * The longest silence between two heartbeats the server still joins into one session. A longer
 * gap (sleep, a closed lid, a lost network) ends the session at its last moment of activity.
 */
export const ACTIVITY_GAP_SECONDS = 150;
/** The largest `idleSeconds` a heartbeat may carry (one day). */
export const ACTIVITY_MAX_IDLE_SECONDS = 24 * 60 * 60;

/**
 * What the tracker shows: `off` (not tracking), `active` (Tracking), `idle` (Paused, computer
 * idle), `locked` (Paused, screen locked) or `asleep` (Paused, computer asleep).
 */
export type ActivityStatus = 'off' | 'active' | 'idle' | 'locked' | 'asleep';

export interface ActivityTrackerState {
  readonly status: ActivityStatus;
  readonly idleThresholdSeconds: number;
  /** Device clock (ms) of the last heartbeat sent, or null. */
  readonly lastHeartbeatAt: number | null;
  /** The last sample: when it was read (ms) and the idle seconds it reported. */
  readonly lastSampleAt: number | null;
  readonly lastIdleSeconds: number;
}

/** One signal from the source. `at` is the device clock in ms (only used for spacing). */
export type ActivitySignal =
  | { readonly type: 'enable'; readonly idleThresholdSeconds: number }
  | { readonly type: 'disable' }
  | { readonly type: 'sample'; readonly at: number; readonly idleSeconds: number }
  | { readonly type: 'locked'; readonly at: number }
  | { readonly type: 'unlocked'; readonly at: number }
  | { readonly type: 'suspended'; readonly at: number }
  | { readonly type: 'resumed'; readonly at: number };

export interface ActivityHeartbeat {
  /** Whole seconds since the last keyboard or mouse input on the computer. */
  readonly idleSeconds: number;
}

export interface ActivityStep {
  readonly state: ActivityTrackerState;
  /** Send this heartbeat now, or nothing. */
  readonly heartbeat: ActivityHeartbeat | null;
}

export const INITIAL_ACTIVITY_STATE: ActivityTrackerState = Object.freeze({
  status: 'off',
  idleThresholdSeconds: IDLE_THRESHOLD_DEFAULT_MINUTES * 60,
  lastHeartbeatAt: null,
  lastSampleAt: null,
  lastIdleSeconds: 0,
});

/** Whole, non-negative idle seconds, at most a day; anything unreadable reads as a day. */
export function clampIdleSeconds(raw: number): number {
  if (!Number.isFinite(raw)) return ACTIVITY_MAX_IDLE_SECONDS;
  return Math.min(ACTIVITY_MAX_IDLE_SECONDS, Math.max(0, Math.floor(raw)));
}

/** A threshold in seconds inside the allowed minutes. */
export function clampIdleThresholdSeconds(raw: number): number {
  const minutes = Number.isFinite(raw) ? raw / 60 : IDLE_THRESHOLD_DEFAULT_MINUTES;
  const bounded = Math.min(
    IDLE_THRESHOLD_MAX_MINUTES,
    Math.max(IDLE_THRESHOLD_MIN_MINUTES, minutes),
  );
  return Math.round(bounded * 60);
}

/** The idle seconds now, estimated from the last sample (for a lock or sleep between samples). */
function idleSecondsAt(state: ActivityTrackerState, at: number): number {
  if (state.lastSampleAt === null) return 0;
  return clampIdleSeconds(state.lastIdleSeconds + Math.max(0, at - state.lastSampleAt) / 1000);
}

/**
 * The tracker. Pure: the caller feeds signals and sends the heartbeats it returns.
 *
 * - `sample` with input inside the threshold: Tracking. A heartbeat goes out on becoming active
 *   and then once per {@link ACTIVITY_HEARTBEAT_SECONDS}.
 * - `sample` past the threshold: Paused (idle). One last heartbeat carries the idle seconds, so
 *   the server ends the session at the last real input.
 * - `locked` / `suspended`: Paused; when it was Tracking, one last heartbeat with the idle seconds
 *   estimated from the last sample. Samples are ignored until `unlocked` / `resumed`.
 * - `unlocked` / `resumed`: Paused (idle) until a sample shows input.
 */
export function stepActivity(state: ActivityTrackerState, signal: ActivitySignal): ActivityStep {
  if (signal.type === 'disable') {
    return {
      state: { ...INITIAL_ACTIVITY_STATE, idleThresholdSeconds: state.idleThresholdSeconds },
      heartbeat: null,
    };
  }
  if (signal.type === 'enable') {
    const idleThresholdSeconds = clampIdleThresholdSeconds(signal.idleThresholdSeconds);
    if (state.status !== 'off')
      return { state: { ...state, idleThresholdSeconds }, heartbeat: null };
    return {
      state: { ...INITIAL_ACTIVITY_STATE, status: 'idle', idleThresholdSeconds },
      heartbeat: null,
    };
  }
  if (state.status === 'off') return { state, heartbeat: null };

  switch (signal.type) {
    case 'sample': {
      if (state.status === 'locked' || state.status === 'asleep') return { state, heartbeat: null };
      const idleSeconds = clampIdleSeconds(signal.idleSeconds);
      const sampled = { ...state, lastSampleAt: signal.at, lastIdleSeconds: idleSeconds };
      if (idleSeconds < state.idleThresholdSeconds) {
        const due =
          state.status !== 'active' ||
          state.lastHeartbeatAt === null ||
          signal.at - state.lastHeartbeatAt >= ACTIVITY_HEARTBEAT_SECONDS * 1000;
        return due
          ? {
              state: { ...sampled, status: 'active', lastHeartbeatAt: signal.at },
              heartbeat: { idleSeconds },
            }
          : { state: { ...sampled, status: 'active' }, heartbeat: null };
      }
      if (state.status === 'active') {
        return {
          state: { ...sampled, status: 'idle', lastHeartbeatAt: signal.at },
          heartbeat: { idleSeconds },
        };
      }
      return { state: { ...sampled, status: 'idle' }, heartbeat: null };
    }
    case 'locked':
    case 'suspended': {
      const status: ActivityStatus = signal.type === 'locked' ? 'locked' : 'asleep';
      if (state.status === 'active') {
        return {
          state: { ...state, status, lastHeartbeatAt: signal.at },
          heartbeat: { idleSeconds: idleSecondsAt(state, signal.at) },
        };
      }
      return { state: { ...state, status }, heartbeat: null };
    }
    case 'unlocked':
    case 'resumed': {
      if (state.status !== 'locked' && state.status !== 'asleep') return { state, heartbeat: null };
      return { state: { ...state, status: 'idle', lastSampleAt: null }, heartbeat: null };
    }
  }
}
