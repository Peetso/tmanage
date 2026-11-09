import { describe, expect, it } from 'vitest';
import {
  POWER_MONITOR_EVENTS,
  isActivityEvent,
  toActivityEvent,
  toActivitySample,
} from '../src/activity';

describe('desktop activity signal', () => {
  it('passes only whole idle seconds and the lock state', () => {
    expect(toActivitySample(12.9, 'active')).toEqual({ idleSeconds: 12, locked: false });
    expect(toActivitySample(-3, 'idle')).toEqual({ idleSeconds: 0, locked: false });
    expect(toActivitySample(Number.NaN, 'locked')).toEqual({ idleSeconds: 0, locked: true });
    expect(Object.keys(toActivitySample(1, 'unknown'))).toEqual(['idleSeconds', 'locked']);
  });

  it('maps lock, unlock, sleep and wake, and nothing else', () => {
    expect(POWER_MONITOR_EVENTS.map(toActivityEvent)).toEqual([
      'locked',
      'unlocked',
      'suspended',
      'resumed',
    ]);
    expect(toActivityEvent('on-ac')).toBeNull();
    expect(isActivityEvent('locked')).toBe(true);
    expect(isActivityEvent('window-title')).toBe(false);
  });
});
