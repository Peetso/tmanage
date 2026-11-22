import { describe, expect, it, vi } from 'vitest';
import { parseTrackQuery, summarize, timeline, TRACK_MAX_LOOKBACK_DAYS } from './attack-tracks.js';
import type { TrackAuthRow } from './attack-tracks.js';
import { AttackTracksService } from './attack-tracks.service.js';
import type { AttackTrackDependencies } from './attack-tracks.service.js';
import { SourceLabelMatcher } from './source-labels.js';
import type { AttackTrackStore } from './attack-tracks.repository.js';
import { sourceHash } from './source-findings.js';
import type { PlatformAdminActor } from '../platform-admin/platform-admin.guard.js';

/** SEC-ALERTS item 6: the 2026-11-21 tester's trace as one track. */

const NOW = new Date('2026-11-21T15:30:00.000Z');
const IP = '48.47.63.166';
const USER = '0190a000-0000-7000-8000-000000000001';
const at = (iso: string) => new Date(`2026-11-21T${iso}Z`);
const row = (over: Partial<TrackAuthRow> & { readonly occurredAt: Date }): TrackAuthRow => ({
  ip: IP,
  userId: USER,
  action: 'password_sign_in',
  outcome: 'failed',
  reason: 'bad_password',
  userAgent: 'Mozilla/5.0 (Windows NT 10.0) Chrome/131',
  ...over,
});

const yesterday = [
  row({ occurredAt: at('14:53:00'), outcome: 'succeeded', reason: null }),
  ...['15:10:23.000', '15:10:23.100', '15:10:23.200', '15:10:23.300'].map((t) =>
    row({ occurredAt: at(t), action: 'csrf_guard', reason: 'csrf_failed', userId: null }),
  ),
  ...['15:16:29.000', '15:16:29.300', '15:16:29.600', '15:16:29.900'].map((t) =>
    row({ occurredAt: at(t) }),
  ),
  row({ occurredAt: at('15:16:30.200'), reason: 'source_account_throttled', userId: null }),
];

describe('attack track model', () => {
  it('groups the trace, drops the success before any failure, flags no breach', () => {
    const track = summarize({
      trackId: sourceHash(IP),
      ip: IP,
      rows: yesterday,
      network: null,
      signals: [{ ruleKey: 'credential_stuffing', severity: 'high' }],
    });
    expect(track).toMatchObject({
      steps: 9,
      refused: 8,
      throttled: 1,
      succeeded: 0,
      breached: false,
      severity: 'high',
      accountsTargeted: [USER],
      signals: ['credential_stuffing'],
      firstSeen: at('15:10:23.000'),
    });
  });

  it('marks a success after failures as a breach (critical)', () => {
    const rows = [
      ...yesterday,
      row({ occurredAt: at('15:20:00'), outcome: 'succeeded', reason: null }),
    ];
    const track = summarize({ trackId: 'x', ip: IP, rows, network: null, signals: [] });
    expect(track).toMatchObject({ breached: true, succeeded: 1, severity: 'critical' });
    expect(timeline(rows, []).at(-1)).toMatchObject({ outcome: 'succeeded', kind: 'sign_in' });
  });

  it('a signed-out polling tab is a low track', () => {
    const rows = Array.from({ length: 60 }, (_, i) =>
      row({
        occurredAt: new Date(NOW.getTime() - i * 60_000),
        action: 'session_guard',
        reason: 'missing_session',
        userId: null,
      }),
    );
    expect(summarize({ trackId: 'x', ip: IP, rows, network: null, signals: [] })?.severity).toBe(
      'low',
    );
  });

  it('clamps the window to the 24-month retention and rejects a bad limit', () => {
    const q = parseTrackQuery({ from: '2000-01-01T00:00:00Z' }, NOW);
    expect(q.from).toEqual(new Date(NOW.getTime() - TRACK_MAX_LOOKBACK_DAYS * 86_400_000));
    expect(() => parseTrackQuery({ limit: '0' }, NOW)).toThrow();
  });
});

describe('attack track service', () => {
  const actor = { account: { userId: USER, email: 'admin@platform.test' } } as PlatformAdminActor;
  const context = {
    correlationId: '0190a000-0000-7000-8000-0000000000cc',
    ip: null,
    userAgent: null,
  };

  const deps = (): AttackTrackDependencies => ({
    standing: {
      standing: (sources) =>
        Promise.resolve(
          new Map(
            sources.map((x) => [x.ip, { blocked: false, blockId: null, allowlisted: false }]),
          ),
        ),
      listsHolding: () => Promise.resolve([]),
    },
    labels: { matcher: () => Promise.resolve(new SourceLabelMatcher([])) },
    people: { accounts: () => Promise.resolve([]), userIdByEmail: () => Promise.resolve(null) },
  });

  function store(): AttackTrackStore & { audit: ReturnType<typeof vi.fn> } {
    return {
      recentSources: () => Promise.resolve([IP]),
      allSources: () => Promise.resolve(['203.0.113.1', IP]),
      authRows: () => Promise.resolve(yesterday),
      networks: () => Promise.resolve(new Map()),
      signals: () => Promise.resolve([]),
      publicLinkRefusals: () => Promise.resolve([]),
      rateLimitHits: () => Promise.resolve([]),
      audit: vi.fn(() => Promise.resolve()),
    };
  }

  it('audits the list and the detail; the detail resolves the hash, never takes an address', async () => {
    const s = store();
    const service = new AttackTracksService(s, {}, deps(), () => NOW);
    const page = await service.list(actor, {}, context);
    expect(page.tracks.map((t) => t.trackId)).toEqual([sourceHash(IP)]);
    const detail = await service.get(actor, sourceHash(IP), context);
    expect(detail.timeline).toHaveLength(9);
    expect(s.audit.mock.calls.map((c) => (c[0] as { action: string }).action)).toEqual([
      'platform.attack_tracks_viewed',
      'platform.attack_track_viewed',
    ]);
    expect(JSON.stringify(s.audit.mock.calls)).not.toContain(IP);
    await expect(service.get(actor, IP, context)).rejects.toMatchObject({ status: 404 });
  });
});
