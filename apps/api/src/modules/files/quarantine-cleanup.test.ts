import { describe, expect, it } from 'vitest';
import { describeCleanup, retentionCutoff } from './quarantine-cleanup.js';

/**
 * FILE-003. The two pure pieces worth a unit test: the retention cutoff the pass measures a
 * rejection's age against, and the one line it prints. The DB suite proves the purge itself —
 * delete-before-decrement, idempotency, the audit row, two tenants never mixing — under a real
 * driver and real counters; these prove the arithmetic and the summary that rest beside it.
 */

describe('retentionCutoff', () => {
  it('is the window in days before now', () => {
    const now = new Date('2026-09-20T00:00:00.000Z');
    // 30 days is the FILE_RETENTION_REJECTED_DAYS default.
    expect(retentionCutoff(now, 30).toISOString()).toBe('2026-08-21T00:00:00.000Z');
  });

  it('is now itself for a zero-day window', () => {
    const now = new Date('2026-09-20T12:34:56.000Z');
    expect(retentionCutoff(now, 0).getTime()).toBe(now.getTime());
  });

  it('reaches further back as the window grows', () => {
    const now = new Date('2026-09-20T00:00:00.000Z');
    expect(retentionCutoff(now, 90).getTime()).toBeLessThan(retentionCutoff(now, 30).getTime());
  });
});

describe('describeCleanup', () => {
  it('names counter drift only when it happened', () => {
    const base = { organizations: 1, scanned: 3, purged: 2, skipped: 1, failed: 0 };
    expect(describeCleanup({ ...base, counterDrift: 0 })).toBe(
      'scanned 3, purged 2, skipped 1, failed 0 (1 organization(s))',
    );
    expect(describeCleanup({ ...base, counterDrift: 1 })).toBe(
      'scanned 3, purged 2, skipped 1, failed 0, 1 with counter drift (1 organization(s))',
    );
  });
});
