import { ACTIVITY_SAMPLE_SECONDS, type ActivitySignal } from '@tmanage/domain';

/**
 * FIX-2026-11-10 — where the whole-computer activity signal comes from in the web app.
 *
 * - **Desktop app**: `window.tmanageDesktop.activity` (apps/desktop/src/preload.ts), Electron's
 *   `powerMonitor`: seconds since the last input anywhere on the computer, lock / unlock and
 *   sleep / wake events.
 * - **Chrome and Edge**: the Idle Detection API (`IdleDetector`): system-wide idle and screen lock,
 *   after one permission click, while a TManage tab is open. Its threshold is one minute, so the
 *   last input is known to the minute.
 * - **Anywhere else** (Firefox, Safari): nothing. Page activity is not computer activity, so there
 *   is no fallback; the screen says automatic tracking needs the desktop app or Chrome / Edge.
 *
 * Only the idle seconds and the lock state are read. No keystrokes, screenshots, app or window
 * names or URLs.
 */

export type ActivitySupport = 'desktop' | 'idle-detector' | 'unsupported';

/** The desktop bridge's activity half, as the preload exposes it. */
export interface DesktopActivityBridge {
  sample(): Promise<{ readonly idleSeconds: number; readonly locked: boolean } | null>;
  onEvent(listener: (event: 'locked' | 'unlocked' | 'suspended' | 'resumed') => void): () => void;
}

/** The part of the Idle Detection API this file uses (not yet in TypeScript's DOM types). */
interface IdleDetectorLike extends EventTarget {
  readonly userState: 'active' | 'idle' | null;
  readonly screenState: 'locked' | 'unlocked' | null;
  start(options: { readonly threshold: number; readonly signal: AbortSignal }): Promise<void>;
}

interface IdleDetectorConstructor {
  new (): IdleDetectorLike;
  requestPermission(): Promise<'granted' | 'denied'>;
}

/** The Idle Detection API's smallest threshold, in ms. */
const IDLE_DETECTOR_THRESHOLD_MS = 60_000;
/** A tick this late means the computer slept (the page's timers stopped). */
const SLEEP_GAP_MS = ACTIVITY_SAMPLE_SECONDS * 4 * 1000;

function desktopBridge(): DesktopActivityBridge | null {
  if (typeof window === 'undefined') return null;
  const bridge = (window as unknown as { tmanageDesktop?: { activity?: DesktopActivityBridge } })
    .tmanageDesktop?.activity;
  return bridge && typeof bridge.sample === 'function' ? bridge : null;
}

function idleDetectorClass(): IdleDetectorConstructor | null {
  if (typeof window === 'undefined') return null;
  const ctor = (window as unknown as { IdleDetector?: IdleDetectorConstructor }).IdleDetector;
  return typeof ctor === 'function' ? ctor : null;
}

export function activitySupport(): ActivitySupport {
  if (desktopBridge() !== null) return 'desktop';
  if (idleDetectorClass() !== null) return 'idle-detector';
  return 'unsupported';
}

/** Item 12: the browser's idle-detection permission. `denied` = blocked in the site settings. */
export type IdlePermission = 'granted' | 'prompt' | 'denied';

/**
 * The permission now, and a listener for changes (the person allows or blocks it in the site
 * settings). The desktop app needs none. Returns the function that stops listening.
 */
export function watchIdlePermission(listener: (state: IdlePermission) => void): () => void {
  if (activitySupport() === 'desktop') {
    listener('granted');
    return () => undefined;
  }
  if (typeof navigator === 'undefined' || !navigator.permissions) {
    listener('prompt');
    return () => undefined;
  }
  let status: PermissionStatus | null = null;
  let stopped = false;
  const onChange = () => {
    if (status !== null) listener(asIdlePermission(status.state));
  };
  navigator.permissions
    .query({ name: 'idle-detection' as PermissionName })
    .then((found) => {
      if (stopped) return;
      status = found;
      listener(asIdlePermission(found.state));
      found.addEventListener('change', onChange);
    })
    .catch(() => listener('prompt'));
  return () => {
    stopped = true;
    status?.removeEventListener('change', onChange);
  };
}

function asIdlePermission(state: PermissionState): IdlePermission {
  return state === 'granted' || state === 'denied' ? state : 'prompt';
}

/** Whether the browser already granted idle detection (no prompt needed). */
export async function idleDetectionGranted(): Promise<boolean> {
  if (activitySupport() === 'desktop') return true;
  if (typeof navigator === 'undefined' || !navigator.permissions) return false;
  try {
    const status = await navigator.permissions.query({
      name: 'idle-detection' as PermissionName,
    });
    return status.state === 'granted';
  } catch {
    return false;
  }
}

/** Ask for idle detection. Must run from a click (the browser requires a user gesture). */
export async function requestIdleDetection(): Promise<boolean> {
  const ctor = idleDetectorClass();
  if (ctor === null) return activitySupport() === 'desktop';
  try {
    return (await ctor.requestPermission()) === 'granted';
  } catch {
    return false;
  }
}

/**
 * Start reading the signal; `emit` receives tracker signals. Returns the function that stops it.
 * A long pause between ticks (the computer slept) is reported as suspended, then resumed.
 */
export function startActivitySource(
  emit: (signal: ActivitySignal) => void,
  now: () => number = () => Date.now(),
): () => void {
  const support = activitySupport();
  if (support === 'unsupported') return () => undefined;
  const stops: (() => void)[] = [];
  let lastTick = now();
  let locked = false;

  const lock = (next: boolean) => {
    if (next === locked) return;
    locked = next;
    emit({ type: next ? 'locked' : 'unlocked', at: now() });
  };

  let read: () => Promise<number | null>;
  if (support === 'desktop') {
    const bridge = desktopBridge() as DesktopActivityBridge;
    stops.push(
      bridge.onEvent((event) => {
        if (event === 'locked' || event === 'unlocked') lock(event === 'locked');
        else emit({ type: event, at: now() });
      }),
    );
    read = async () => {
      const sample = await bridge.sample();
      if (sample === null) return null;
      lock(sample.locked);
      return sample.idleSeconds;
    };
  } else {
    const ctor = idleDetectorClass() as IdleDetectorConstructor;
    const controller = new AbortController();
    const detector = new ctor();
    let idleSince: number | null = null;
    const onChange = () => {
      lock(detector.screenState === 'locked');
      if (detector.userState === 'idle') idleSince ??= now();
      else idleSince = null;
    };
    detector.addEventListener('change', onChange);
    void detector
      .start({ threshold: IDLE_DETECTOR_THRESHOLD_MS, signal: controller.signal })
      .then(onChange)
      .catch(() => undefined);
    stops.push(() => {
      detector.removeEventListener('change', onChange);
      controller.abort();
    });
    read = async () =>
      idleSince === null
        ? 0
        : Math.floor((IDLE_DETECTOR_THRESHOLD_MS + Math.max(0, now() - idleSince)) / 1000);
  }

  const tick = async () => {
    const at = now();
    if (at - lastTick > SLEEP_GAP_MS) {
      emit({ type: 'suspended', at: lastTick });
      emit({ type: 'resumed', at });
    }
    lastTick = at;
    if (locked) return;
    const idleSeconds = await read().catch(() => null);
    if (idleSeconds !== null && !locked) emit({ type: 'sample', at: now(), idleSeconds });
  };
  void tick();
  const handle = window.setInterval(() => void tick(), ACTIVITY_SAMPLE_SECONDS * 1000);
  stops.push(() => window.clearInterval(handle));
  return () => {
    for (const stop of stops) stop();
  };
}
