/**
 * The "update available" toast's state machine (slice 08, the updater intent).
 *
 * The service worker from slice 01 no longer activates a new build the moment it installs; a
 * fresh worker now parks in the *waiting* state until the window tells it to take over. This
 * module decides, purely, whether the toast that offers that reload should be on screen — kept
 * apart from the component so the rule can be proven without a real `ServiceWorkerRegistration`.
 */

/** The message a controlled page posts to a waiting worker to make it take over immediately. */
export const SKIP_WAITING_MESSAGE = { type: 'SKIP_WAITING' } as const;

/** Whether the toast is shown. A two-state machine: a waiting build exists and is not dismissed. */
export type UpdateToastState = 'hidden' | 'available';

export interface UpdateToastInput {
  /** A new worker has installed and is waiting to activate (`registration.waiting` is set). */
  readonly hasWaitingWorker: boolean;
  /** The person has dismissed this offer; it stays hidden until the next waiting worker. */
  readonly dismissed: boolean;
}

/**
 * Derive the toast state. Shown only when a waiting worker exists **and** the person has not
 * dismissed the current offer; hidden in every other case, including before any update and on
 * the very first install (which has no previous build to replace, so nothing ever waits).
 */
export function deriveUpdateToastState({
  hasWaitingWorker,
  dismissed,
}: UpdateToastInput): UpdateToastState {
  return hasWaitingWorker && !dismissed ? 'available' : 'hidden';
}
