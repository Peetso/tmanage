import { describe, expect, it } from 'vitest';
import { ApiRequestError } from '../src/lib/api/errors';
import type { RunningTimer } from '../src/lib/api/time-timer';
import {
  elapsedNow,
  formatElapsed,
  isTimerRunningConflict,
  minutesToRecord,
  timerActionFor,
} from '../src/lib/timer-state';

const timer = (over: Partial<RunningTimer> = {}): RunningTimer => ({
  id: 't1',
  workItemId: 'wi-1',
  projectId: 'p-1',
  note: null,
  billable: true,
  startedAt: '2026-11-08T09:00:00.000Z',
  lastHeartbeatAt: '2026-11-08T09:00:00.000Z',
  elapsedSeconds: 100,
  ...over,
});

describe('52-01 timer state', () => {
  it('formats elapsed time as HH:MM:SS, past 99 hours and never negative', () => {
    expect(formatElapsed(2535)).toBe('00:42:15');
    expect(formatElapsed(360_000)).toBe('100:00:00');
    expect(formatElapsed(-5)).toBe('00:00:00');
  });

  it('adds only local time since the server answered to the server elapsed figure', () => {
    expect(elapsedNow(timer(), 1_000_000, 1_005_900)).toBe(105);
    // A device clock behind the fetch moment never subtracts.
    expect(elapsedNow(timer(), 1_000_000, 990_000)).toBe(100);
  });

  it('starts when idle, stops on the same item, asks before switching items', () => {
    expect(timerActionFor(null, 'wi-1')).toBe('start');
    expect(timerActionFor(timer(), 'wi-1')).toBe('stop');
    expect(timerActionFor(timer({ workItemId: 'wi-2' }), 'wi-1')).toBe('confirm-switch');
    expect(timerActionFor(timer({ workItemId: null }), 'wi-1')).toBe('confirm-switch');
  });

  it('recognises the API refusal for a second running timer only', () => {
    const conflict = new ApiRequestError(409, 'conflict', 'x', 'c', [
      { field: 'timer', message: 'timer_running' },
    ]);
    const other = new ApiRequestError(409, 'conflict', 'x', 'c', [
      { field: 'timer', message: 'timer_not_running' },
    ]);
    expect(isTimerRunningConflict(conflict)).toBe(true);
    expect(isTimerRunningConflict(other)).toBe(false);
    expect(isTimerRunningConflict(new Error('timer_running'))).toBe(false);
  });

  it('records at least one minute and counts a started minute', () => {
    expect(minutesToRecord(0)).toBe(1);
    expect(minutesToRecord(61)).toBe(2);
    expect(minutesToRecord(2520)).toBe(42);
  });
});
