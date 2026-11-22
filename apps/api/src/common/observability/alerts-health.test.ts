import { describe, expect, it } from 'vitest';
import { ALERT_STUCK_MINUTES, evaluateAlertsHealth } from './alerts-health.js';

const NOW = new Date('2026-11-22T09:00:00.000Z');
const ago = (minutes: number) => new Date(NOW.getTime() - minutes * 60_000);

describe('SEC-ALERTS healthz alerts check', () => {
  it('is not_configured while ALERT_EMAILS is empty (the 2026-11-21 live state)', () => {
    expect(evaluateAlertsHealth(false, { oldestPending: ago(600), recentNone: true }, NOW)).toBe(
      'not_configured',
    );
  });

  it('is degraded when a pending signal outlived the digest window (the send failed)', () => {
    const stuck = { oldestPending: ago(ALERT_STUCK_MINUTES + 1), recentNone: false };
    expect(evaluateAlertsHealth(true, stuck, NOW)).toBe('degraded');
  });

  it('is degraded when a signal was just marked none, or the table is unreadable', () => {
    expect(evaluateAlertsHealth(true, { oldestPending: null, recentNone: true }, NOW)).toBe(
      'degraded',
    );
    expect(evaluateAlertsHealth(true, null, NOW)).toBe('degraded');
  });

  it('is ok when configured and a pending row is still inside the window', () => {
    expect(evaluateAlertsHealth(true, { oldestPending: ago(10), recentNone: false }, NOW)).toBe(
      'ok',
    );
    expect(evaluateAlertsHealth(true, { oldestPending: null, recentNone: false }, NOW)).toBe('ok');
  });
});
