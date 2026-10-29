import { describe, expect, it } from 'vitest';
import {
  MAIL_LANES,
  allowance,
  effectiveCeiling,
  laneForTemplate,
  mailboxForLane,
  spreadMinute,
} from './lanes.js';

describe('UNIT-56-31 — lanes', () => {
  it('drains auth → transactional → digest → bulk', () => {
    expect(MAIL_LANES).toEqual(['auth', 'transactional', 'digest', 'bulk']);
  });

  it('maps known templates and never makes an unknown key auth', () => {
    expect(laneForTemplate('password_reset')).toBe('auth');
    expect(laneForTemplate('sign_in_code')).toBe('auth');
    expect(laneForTemplate('invitation')).toBe('transactional');
    expect(laneForTemplate('digest')).toBe('digest');
    expect(laneForTemplate('announcement')).toBe('bulk');
    for (const key of [undefined, null, '', 'auth', 'AUTH', 'sign_in_code ', '__proto__', 'x']) {
      expect(laneForTemplate(key)).toBe('transactional');
    }
  });

  it('sends auth from security@ only when it is configured', () => {
    expect(mailboxForLane('auth', true)).toBe('security');
    expect(mailboxForLane('auth', false)).toBe('noreply');
    expect(mailboxForLane('bulk', true)).toBe('noreply');
  });

  it('keeps 10 % margin and 20 % of a shared mailbox for transactional', () => {
    expect(effectiveCeiling(300)).toBe(270);
    expect(allowance('bulk', 0, 300)).toBe(216);
    expect(allowance('digest', 216, 300)).toBe(0);
    expect(allowance('transactional', 216, 300)).toBe(54);
    expect(allowance('auth', 269, 300, false)).toBe(1);
    expect(allowance('auth', 400, 300)).toBe(0);
  });

  it('spreads users across the hour, stably', () => {
    expect(spreadMinute('user-1')).toBe(spreadMinute('user-1'));
    const minutes = new Set(Array.from({ length: 200 }, (_, i) => spreadMinute(`u${String(i)}`)));
    expect(minutes.size).toBeGreaterThan(40);
    for (const minute of minutes) expect(minute).toBeGreaterThanOrEqual(0);
    for (const minute of minutes) expect(minute).toBeLessThan(60);
  });
});
