import { describe, expect, it } from 'vitest';
import { evaluateBackupHealth } from './backup-health.js';

const now = new Date('2026-10-29T12:00:00Z');
const hoursAgo = (h: number): Date => new Date(now.getTime() - h * 3_600_000);

describe('backups reading of /healthz/deep (51-09, 56-29)', () => {
  it('is not_configured with no run, ok when fresh host-only, stale past 26 h', () => {
    expect(evaluateBackupHealth([], now)).toBe('not_configured');
    const hostOnly = { offsiteStatus: 'skipped', offsiteAt: null };
    expect(evaluateBackupHealth([{ ...hostOnly, finishedAt: hoursAgo(25) }], now)).toBe('ok');
    expect(evaluateBackupHealth([{ ...hostOnly, finishedAt: hoursAgo(27) }], now)).toBe('stale');
  });

  it('needs a fresh off-site copy once off-site is requested, and 7 h when 6-hourly', () => {
    const old = { finishedAt: hoursAgo(30), offsiteStatus: 'uploaded', offsiteAt: hoursAgo(30) };
    expect(evaluateBackupHealth([old], now)).toBe('stale');
    const good = { finishedAt: hoursAgo(8), offsiteStatus: 'uploaded', offsiteAt: hoursAgo(8) };
    expect(evaluateBackupHealth([good], now)).toBe('ok');
    expect(evaluateBackupHealth([good], now, { sixHourly: true })).toBe('stale');
  });
});

describe('a failed backup surfaces at once (OFFSITE-BACKUP)', () => {
  const good = {
    status: 'ok',
    finishedAt: hoursAgo(8),
    offsiteStatus: 'uploaded',
    offsiteAt: hoursAgo(8),
  };

  it('is failed when the newest run failed, even while an older good backup is still fresh', () => {
    const failed = {
      status: 'failed',
      finishedAt: hoursAgo(1),
      offsiteStatus: 'failed',
      offsiteAt: null,
    };
    expect(evaluateBackupHealth([failed, good], now)).toBe('failed');
  });

  it('is failed when the newest dump succeeded but its requested off-site copy failed', () => {
    const offsiteFailed = {
      status: 'ok',
      finishedAt: hoursAgo(1),
      offsiteStatus: 'failed',
      offsiteAt: null,
    };
    expect(evaluateBackupHealth([offsiteFailed, good], now)).toBe('failed');
  });

  it('is failed, not not_configured, when every recorded run failed', () => {
    const failed = {
      status: 'failed',
      finishedAt: hoursAgo(1),
      offsiteStatus: 'failed',
      offsiteAt: null,
    };
    expect(evaluateBackupHealth([failed], now)).toBe('failed');
  });

  it('recovers to ok once a retry succeeds', () => {
    const failed = {
      status: 'failed',
      finishedAt: hoursAgo(9),
      offsiteStatus: 'failed',
      offsiteAt: null,
    };
    expect(evaluateBackupHealth([good, failed], now)).toBe('ok');
  });
});
