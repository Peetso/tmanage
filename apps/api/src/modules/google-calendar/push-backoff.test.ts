import { describe, expect, it } from 'vitest';

import { PUSH_BACKOFF_CAP_MS, PUSH_BACKOFF_FIRST_MS, PushBackoff } from './push-backoff.js';

describe('PushBackoff', () => {
  it('doubles the wait after each failure and caps it at 6 hours, quiet at the cap', () => {
    const backoff = new PushBackoff();
    let now = 0;
    const waits: (number | null)[] = [];
    for (let i = 0; i < 12; i += 1) {
      waits.push(backoff.failed('c1', now));
      now += PUSH_BACKOFF_CAP_MS;
    }
    expect(waits.slice(0, 3)).toEqual([
      PUSH_BACKOFF_FIRST_MS,
      PUSH_BACKOFF_FIRST_MS * 2,
      PUSH_BACKOFF_FIRST_MS * 4,
    ]);
    const logged = waits.filter((w) => w !== null);
    expect(logged.at(-1)).toBe(PUSH_BACKOFF_CAP_MS);
    expect(waits.at(-1)).toBeNull();
    expect(new Set(logged).size).toBe(logged.length);
  });

  it('holds the connection until its wait is over, and per connection', () => {
    const backoff = new PushBackoff();
    backoff.failed('c1', 1_000);
    expect(backoff.mayTry('c1', 1_000 + PUSH_BACKOFF_FIRST_MS - 1)).toBe(false);
    expect(backoff.mayTry('c2', 1_000)).toBe(true);
    expect(backoff.mayTry('c1', 1_000 + PUSH_BACKOFF_FIRST_MS)).toBe(true);
  });

  it('a success resets the wait to the first step', () => {
    const backoff = new PushBackoff();
    backoff.failed('c1', 0);
    backoff.failed('c1', 0);
    backoff.succeeded('c1');
    expect(backoff.mayTry('c1', 0)).toBe(true);
    expect(backoff.failed('c1', 0)).toBe(PUSH_BACKOFF_FIRST_MS);
  });
});
