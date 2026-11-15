import { describe, expect, it } from 'vitest';
import {
  ACTIVITY_HEARTBEAT_SECONDS,
  INITIAL_ACTIVITY_STATE,
  clampIdleSeconds,
  clampIdleThresholdSeconds,
  stepActivity,
  type ActivitySignal,
  type ActivityStep,
  type ActivityTrackerState,
} from './auto-tracking.js';

const S = 1000;
const THRESHOLD = 300;

function run(
  signals: readonly ActivitySignal[],
  from: ActivityTrackerState = INITIAL_ACTIVITY_STATE,
) {
  let state = from;
  const steps: ActivityStep[] = [];
  for (const signal of signals) {
    const step = stepActivity(state, signal);
    steps.push(step);
    state = step.state;
  }
  return { state, steps, heartbeats: steps.map((step) => step.heartbeat) };
}

const enable: ActivitySignal = { type: 'enable', idleThresholdSeconds: THRESHOLD };
const sample = (seconds: number, idleSeconds: number): ActivitySignal => ({
  type: 'sample',
  at: seconds * S,
  idleSeconds,
});

describe('automatic tracking state machine', () => {
  it('starts paused, tracks on input and sends a heartbeat at once, then once a minute', () => {
    const { state, heartbeats } = run([
      enable,
      sample(0, 2),
      sample(15, 1),
      sample(30, 0),
      sample(ACTIVITY_HEARTBEAT_SECONDS, 4),
    ]);
    expect(state.status).toBe('active');
    expect(heartbeats).toEqual([null, { idleSeconds: 2 }, null, null, { idleSeconds: 4 }]);
  });

  it('idle trimming: past the threshold it pauses and reports how long ago the last input was', () => {
    const { state, heartbeats } = run([enable, sample(0, 0), sample(310, 301), sample(325, 316)]);
    expect(state.status).toBe('idle');
    // The one last heartbeat says "idle for 301 s": the server ends the session 301 s ago.
    expect(heartbeats).toEqual([null, { idleSeconds: 0 }, { idleSeconds: 301 }, null]);
  });

  it('lock: pauses, the last heartbeat carries the idle estimate, samples wait for unlock', () => {
    const { state, heartbeats, steps } = run([
      enable,
      sample(0, 0),
      sample(15, 10),
      { type: 'locked', at: 20 * S },
      sample(35, 0),
      { type: 'unlocked', at: 600 * S },
      sample(615, 3),
    ]);
    expect(steps[3]?.state.status).toBe('locked');
    expect(steps[4]?.state.status).toBe('locked');
    expect(steps[5]?.state.status).toBe('idle');
    expect(state.status).toBe('active');
    // 10 s idle at 15 s, locked at 20 s: the last input was 15 s before the lock.
    expect(heartbeats).toEqual([
      null,
      { idleSeconds: 0 },
      null,
      { idleSeconds: 15 },
      null,
      null,
      { idleSeconds: 3 },
    ]);
  });

  it('sleep and resume: asleep sends nothing more; after resume it waits for real input', () => {
    const { state, heartbeats, steps } = run([
      enable,
      sample(0, 0),
      { type: 'suspended', at: 5 * S },
      sample(3600, 0),
      { type: 'resumed', at: 7200 * S },
      sample(7215, 900),
    ]);
    expect(steps[2]?.state.status).toBe('asleep');
    expect(steps[3]?.heartbeat).toBeNull();
    expect(state.status).toBe('idle');
    expect(heartbeats).toEqual([null, { idleSeconds: 0 }, { idleSeconds: 5 }, null, null, null]);
  });

  it('an idle computer that locks sends no second heartbeat', () => {
    const { heartbeats } = run([
      enable,
      sample(0, 0),
      sample(301, 301),
      { type: 'locked', at: 400 * S },
    ]);
    expect(heartbeats.filter((heartbeat) => heartbeat !== null)).toHaveLength(2);
  });

  it('two devices: each tracker reports only its own idle seconds; the server counts one session', () => {
    // Device B stays active while device A goes idle; both trackers are independent and only
    // send `idleSeconds`. The server joins them (time-auto-rules.test.ts), so nothing doubles.
    const a = run([enable, sample(0, 0), sample(310, 305)]);
    const b = run([enable, sample(0, 0), sample(60, 1), sample(120, 2), sample(180, 0)]);
    expect(a.state.status).toBe('idle');
    expect(b.state.status).toBe('active');
    expect(
      [...a.heartbeats, ...b.heartbeats].every(
        (h) => h === null || Object.keys(h).join() === 'idleSeconds',
      ),
    ).toBe(true);
  });

  it('off ignores everything; disable stops and enable keeps the threshold in range', () => {
    expect(stepActivity(INITIAL_ACTIVITY_STATE, sample(0, 0)).heartbeat).toBeNull();
    const on = run([enable, sample(0, 0)]).state;
    const off = stepActivity(on, { type: 'disable' });
    expect(off.state.status).toBe('off');
    expect(off.heartbeat).toBeNull();
    expect(
      stepActivity(INITIAL_ACTIVITY_STATE, { type: 'enable', idleThresholdSeconds: 5 }).state
        .idleThresholdSeconds,
    ).toBe(60);
    expect(clampIdleThresholdSeconds(99_999)).toBe(900); // IDLE_THRESHOLD_MAX_MINUTES (15) since bcff7784
    expect(clampIdleSeconds(-4)).toBe(0);
    expect(clampIdleSeconds(Number.NaN)).toBe(86_400);
  });
});
