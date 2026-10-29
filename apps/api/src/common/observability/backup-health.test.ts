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
    const failed = { finishedAt: hoursAgo(1), offsiteStatus: 'failed', offsiteAt: null };
    const old = { finishedAt: hoursAgo(30), offsiteStatus: 'uploaded', offsiteAt: hoursAgo(30) };
    expect(evaluateBackupHealth([failed, old], now)).toBe('stale');
    const good = { finishedAt: hoursAgo(8), offsiteStatus: 'uploaded', offsiteAt: hoursAgo(8) };
    expect(evaluateBackupHealth([good], now)).toBe('ok');
    expect(evaluateBackupHealth([good], now, { sixHourly: true })).toBe('stale');
  });
});
