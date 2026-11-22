import { describe, expect, it } from 'vitest';
import {
  allowlistAction,
  allowlistEntryHolding,
  dayGap,
  doorReadings,
  groupTimeline,
  lastListRefresh,
  networkKind,
  parseUserAgent,
  periodFrom,
  visibleFilters,
} from '../src/components/platform/security/attack-tracker-model';
import type { TrackStep, TrackSummary } from '../src/lib/api/platform-security';
import { DOOR, TRACKS, trackDetail } from '../stories/support/attack-tracker-fixtures';

/** SEC-TRACKER — the Attack tracker's pure reading of the API (Figma 833:85442). */

const COUNTS = { all: 8, critical: 1, high: 2, vpn: 2, tor: 1, hosting: 3, known_tester: 0 };

function step(fields: Partial<TrackStep> & Pick<TrackStep, 'at'>): TrackStep {
  return {
    kind: 'sign_in',
    action: 'password_sign_in',
    outcome: 'refused',
    reason: 'bad_password',
    userId: null,
    userAgent: null,
    ...fields,
  };
}

function source(index: number): TrackSummary {
  const found = TRACKS[index];
  if (!found) throw new Error(`no fixture source ${index}`);
  return found;
}

describe('attack tracker model', () => {
  it('reads the window from a minute boundary, so a refetch keeps its key', () => {
    const now = new Date('2026-11-22T12:00:42.500Z');
    expect(periodFrom('24h', now)).toBe('2026-11-21T12:00:00.000Z');
    expect(periodFrom('7d', now)).toBe('2026-11-15T12:00:00.000Z');
    expect(periodFrom('30d', now)).toBe('2026-10-23T12:00:00.000Z');
  });

  it('hides the Known tester chip until a marked source exists, but never while it is selected', () => {
    const all = ['all', 'critical', 'known_tester'] as const;
    expect(visibleFilters(all, COUNTS, 'all')).toEqual(['all', 'critical']);
    expect(visibleFilters(all, { ...COUNTS, known_tester: 1 }, 'all')).toEqual(all);
    expect(visibleFilters(all, COUNTS, 'known_tester')).toEqual(all);
  });

  it('names one network capsule: Tor over VPN over data centre', () => {
    expect(networkKind(source(1).network)).toBe('tor');
    expect(networkKind(source(0).network)).toBe('vpn');
    expect(networkKind(source(2).network)).toBe('hosting');
    expect(networkKind(source(5).network)).toBeNull();
    expect(networkKind(null)).toBeNull();
  });

  it('lets Add to allowlist follow the source (Fable build rule 1)', () => {
    expect(allowlistAction(source(6))).toBe('on-list');
    expect(allowlistAction(source(1))).toBe('blocked');
    expect(allowlistAction(source(0))).toBe('add');
  });

  it('names the allowlist entry an address is inside', () => {
    expect(allowlistEntryHolding(source(6), DOOR.entries)).toBe('48.47.63.166/32');
    expect(allowlistEntryHolding({ ip: '160.79.110.9', network: null }, DOOR.entries)).toBe(
      '160.79.104.0/21',
    );
    expect(allowlistEntryHolding({ ip: '160.79.112.1', network: null }, DOOR.entries)).toBeNull();
    expect(
      allowlistEntryHolding(source(0), [
        { id: 'x', kind: 'asn', value: '60068', note: null, createdAt: '2026-11-22T00:00:00Z' },
      ]),
    ).toBe('AS60068');
  });

  it('reads a user agent as a script or a browser on a system', () => {
    expect(parseUserAgent('curl/8.4.0')).toEqual({ kind: 'script', name: 'curl' });
    expect(parseUserAgent('python-requests/2.31')).toEqual({ kind: 'script', name: 'Python' });
    expect(
      parseUserAgent(
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36',
      ),
    ).toEqual({ kind: 'browser', browser: 'Chrome', system: 'Windows' });
    expect(
      parseUserAgent(
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 Version/17.0 Safari/605.1.15',
      ),
    ).toEqual({ kind: 'browser', browser: 'Safari', system: 'macOS' });
    expect(parseUserAgent('Mozilla/5.0 Chrome/131 Edg/131')).toMatchObject({ browser: 'Edge' });
    expect(parseUserAgent(null)).toBeNull();
    expect(parseUserAgent('  ')).toBeNull();
  });

  it('folds the worst source into the seven lines the design draws, newest first', () => {
    const detail = trackDetail(source(0));
    const groups = groupTimeline(detail.timeline);
    expect(groups.map((group) => [group.step.kind, group.step.outcome, group.times])).toEqual([
      ['sign_in', 'succeeded', 1],
      ['sign_in', 'refused', 1],
      ['signal', 'signal', 1],
      ['public_link', 'refused', 4],
      ['sign_in', 'refused', 38],
      ['rate_limit', 'observed', 9],
      ['sign_in', 'refused', 10],
    ]);
    expect(groups[4]?.userIds).toHaveLength(12);
    // Every attempt is on some line: refused + slowed down + got in.
    const attempts = groups
      .filter((group) => group.step.kind !== 'signal')
      .reduce((sum, group) => sum + group.times, 0);
    expect(attempts).toBe(detail.attempts);
  });

  it('never folds a success into the failures around it', () => {
    const groups = groupTimeline([
      step({ at: '2026-11-22T10:00:03Z', outcome: 'succeeded', reason: null }),
      step({ at: '2026-11-22T10:00:02Z', outcome: 'succeeded', reason: null }),
      step({ at: '2026-11-22T10:00:01Z' }),
    ]);
    expect(groups.map((group) => group.times)).toEqual([1, 1, 1]);
  });

  it('names the door readings that count against a source, once each', () => {
    expect(
      doorReadings([
        'net.a.list:x4b_vpn',
        'net.b.time_zone:mismatch',
        'net.a.list:x4b_vpn',
        'net.c.unknown',
      ]),
    ).toEqual([
      { key: 'AttackTracker.doorOnVpnList' },
      { key: 'AttackTracker.doorClockMismatch', country: true },
    ]);
    expect(doorReadings(['net.blocked', 'net.a.list:something_new'])).toEqual([
      { key: 'AttackTracker.doorBlockedByYou' },
      { key: 'AttackTracker.doorOnAList' },
    ]);
    expect(doorReadings(undefined)).toEqual([]);
  });

  it('reports the newest successful list refresh, ignoring lists never fetched', () => {
    expect(lastListRefresh(DOOR.lists)).toBe(DOOR.lists[0]?.fetchedAt);
    expect(lastListRefresh([])).toBeNull();
  });

  it('counts calendar days in the reader zone', () => {
    const now = new Date(2026, 10, 22, 0, 30);
    expect(dayGap(new Date(2026, 10, 22, 0, 5).toISOString(), now)).toBe(0);
    expect(dayGap(new Date(2026, 10, 21, 23, 55).toISOString(), now)).toBe(1);
    expect(dayGap(new Date(2026, 10, 20, 9, 0).toISOString(), now)).toBe(2);
  });
});
