import { ApiRequestError } from './api/errors';
import type { RunningTimer } from './api/time-timer';

/**
 * 52-01 — the pure rules behind the timer button and the shell's running-timer pill (Figma
 * `574:32611`). Kept free of React so the decisions are unit-tested on their own.
 */

/** `HH:MM:SS`; hours keep counting past 99 rather than wrapping. Negative input reads as zero. */
export function formatElapsed(seconds: number): string {
  const total = Math.max(0, Math.floor(Number.isFinite(seconds) ? seconds : 0));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const rest = total % 60;
  const two = (value: number) => String(value).padStart(2, '0');
  return `${two(hours)}:${two(minutes)}:${two(rest)}`;
}

/**
 * The seconds to show now. The server's `elapsedSeconds` is exact at the moment it answered
 * (`fetchedAtMs` on this device's clock); the local clock only adds the time since, so a skewed
 * device clock never shifts the figure.
 */
export function elapsedNow(timer: RunningTimer, fetchedAtMs: number, nowMs: number): number {
  return Math.max(0, timer.elapsedSeconds + Math.floor(Math.max(0, nowMs - fetchedAtMs) / 1000));
}

export type TimerAction = 'start' | 'stop' | 'confirm-switch';

/**
 * What the timer button on a work item does: start when nothing runs, stop when this item's timer
 * runs, and ask first when another timer runs (one running timer per person).
 */
export function timerActionFor(current: RunningTimer | null, workItemId: string): TimerAction {
  if (current === null) return 'start';
  return current.workItemId === workItemId ? 'stop' : 'confirm-switch';
}

/** True when the API refused a start because another timer is already running. */
export function isTimerRunningConflict(error: unknown): boolean {
  return (
    error instanceof ApiRequestError &&
    error.status === 409 &&
    error.details.some((detail) => detail.message === 'timer_running')
  );
}

/** Whole minutes the stop dialog announces; a started minute counts, never below one. */
export function minutesToRecord(seconds: number): number {
  return Math.max(1, Math.ceil(Math.max(0, seconds) / 60));
}

/** The longest note the API keeps (`optionalNote`), so the field can stop typing there. */
export const TIMER_NOTE_MAX = 500;
