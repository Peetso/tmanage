import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import type { PlatformPermission } from '@tmanage/domain';
import type { PlatformAdminActor } from '../platform-admin/platform-admin.guard.js';
import type { PlatformAuditInput } from '../platform-admin/platform-admin.repository.js';
import {
  compareTracks,
  decodeTrackCursor,
  encodeTrackCursor,
  parseTrackQuery,
  summarize,
} from './attack-tracks.js';
import type { TrackAuthRow, TrackNetwork, TrackSummary } from './attack-tracks.js';
import type { AttackTrackStore } from './attack-tracks.repository.js';
import { AttackTracksService } from './attack-tracks.service.js';
import type { AttackTrackDependencies } from './attack-tracks.service.js';
import { sourceHash } from './source-findings.js';
import { SourceLabelMatcher } from './source-labels.js';
import type { SourceLabel } from './source-labels.js';
import type { SourceLabelStore } from './source-labels.repository.js';
import { SourceLabelsService } from './source-labels.service.js';

/**
 * SEC-TRACKER (Fable 5.2 rulings, 2026-11-22): the attack tracker's gaps 2, 4, 5, 6, 8 and 9.
 * A label never changes severity (or the door, or an alert); names appear only on the audited
 * detail read and only with `platform.people.view`; the four attempt numbers sum; paging is stable
 * under new events; search, chips and totals run on the server.
 */

const NOW = new Date('2026-11-22T12:00:00.000Z');
const TESTER = '48.47.63.166';
const MONA = '0190a000-0000-7000-8000-00000000a001';
const ali = '0190a000-0000-7000-8000-00000000a002';
const minutesAgo = (n: number) => new Date(NOW.getTime() - n * 60_000);

const row = (ip: string, over: Partial<TrackAuthRow> & { readonly occurredAt: Date }) =>
  ({
    ip,
    userId: MONA,
    action: 'password_sign_in',
    outcome: 'failed',
    reason: 'bad_password',
    userAgent: 'curl/8.4',
    ...over,
  }) satisfies TrackAuthRow;

const hosting: TrackNetwork = {
  countryCode: 'NL',
  asn: 60068,
  owner: 'CDN77',
  kind: 'hosting',
  tor: false,
  vpnLikely: true,
};

/** Five failures, one throttle, one door refusal and one success after failing. */
function breachRows(ip: string): TrackAuthRow[] {
  return [
    ...[10, 9, 8, 7, 6].map((m) => row(ip, { occurredAt: minutesAgo(m) })),
    row(ip, { occurredAt: minutesAgo(5), reason: 'source_account_throttled', userId: null }),
    row(ip, {
      occurredAt: minutesAgo(4),
      action: 'network_guard',
      reason: 'vpn_refused',
      userId: null,
    }),
    row(ip, { occurredAt: minutesAgo(3), outcome: 'succeeded', reason: null, userId: ali }),
  ];
}

const label = (value: string, over: Partial<SourceLabel> = {}): SourceLabel => ({
  id: '0193b5a0-0000-7000-8000-00000000b101',
  value,
  label: 'known_tester',
  note: 'Instinct AI tester',
  createdAt: NOW,
  ...over,
});

const actorWith = (permissions: readonly PlatformPermission[]): PlatformAdminActor =>
  ({
    account: { userId: '0190a000-0000-7000-8000-0000000000ad', email: 'admin@platform.test' },
    permissions,
  }) as PlatformAdminActor;
const context = {
  correlationId: '0190a000-0000-7000-8000-0000000000cc',
  ip: null,
  userAgent: null,
};

function world(sources: Record<string, TrackAuthRow[]>, labels: readonly SourceLabel[] = []) {
  const rows = Object.values(sources).flat();
  const audits: PlatformAuditInput[] = [];
  const store: AttackTrackStore = {
    recentSources: (_from, until, limit) => {
      const last = new Map<string, number>();
      for (const r of rows) {
        if (r.outcome === 'succeeded' || r.occurredAt > until) continue;
        last.set(r.ip, Math.max(last.get(r.ip) ?? 0, r.occurredAt.getTime()));
      }
      return Promise.resolve(
        [...last]
          .sort((a, b) => b[1] - a[1])
          .slice(0, limit)
          .map(([ip]) => ip),
      );
    },
    allSources: () => Promise.resolve(Object.keys(sources)),
    authRows: (ips, _from, until) =>
      Promise.resolve(rows.filter((r) => ips.includes(r.ip) && r.occurredAt <= until)),
    networks: (ips) => Promise.resolve(new Map(ips.map((ip) => [ip, hosting]))),
    signals: () => Promise.resolve([]),
    publicLinkRefusals: () => Promise.resolve([]),
    rateLimitHits: () => Promise.resolve([]),
    audit: (input) => {
      audits.push(input);
      return Promise.resolve();
    },
  };
  const accounts = vi.fn((ids: readonly string[]) =>
    Promise.resolve(
      ids.map((userId) => ({
        userId,
        displayName: userId === MONA ? 'Mona Adel' : 'Ali Hassan',
        email: userId === MONA ? 'mona@northwind.test' : 'ali@northwind.test',
        organizations: [{ name: 'Northwind Studio', slug: 'northwind' }],
      })),
    ),
  );
  const deps: AttackTrackDependencies = {
    standing: {
      standing: (list) =>
        Promise.resolve(
          new Map(
            list.map((s) => [
              s.ip,
              {
                blocked: s.ip === '154.47.20.3',
                blockId: s.ip === '154.47.20.3' ? 'blk-1' : null,
                allowlisted: s.ip === TESTER,
              },
            ]),
          ),
        ),
      listsHolding: (ip) => Promise.resolve(ip === '154.47.20.3' ? ['x4b_vpn'] : []),
    },
    labels: { matcher: () => Promise.resolve(new SourceLabelMatcher(labels)) },
    people: {
      accounts,
      userIdByEmail: (email) => Promise.resolve(email === 'ali@northwind.test' ? ali : null),
    },
  };
  let clock = NOW;
  const service = new AttackTracksService(store, {}, deps, () => clock);
  const setClock = (at: Date) => {
    clock = at;
  };
  return { service, audits, accounts, rows, setClock };
}

describe('the four attempt numbers sum, and the door refusals are counted (must-fix 5, gap 6)', () => {
  it('attempts = refused + slowed down + got in; doorRefused is a part of refused', () => {
    const facts = summarize({
      trackId: 'x',
      ip: TESTER,
      rows: breachRows(TESTER),
      network: null,
      signals: [{ ruleKey: 'credential_stuffing', severity: 'high' }],
      extraSteps: [
        {
          at: minutesAgo(1),
          kind: 'signal',
          action: 'credential_stuffing',
          outcome: 'signal',
          reason: 'high',
          userId: null,
          userAgent: null,
        },
      ],
    });
    expect(facts).toMatchObject({ attempts: 8, refused: 6, throttled: 1, succeeded: 1 });
    expect(facts?.doorRefused).toBe(1);
    expect((facts?.refused ?? 0) + (facts?.throttled ?? 0) + (facts?.succeeded ?? 0)).toBe(
      facts?.attempts,
    );
    // Signals are steps, not attempts.
    expect(facts?.steps).toBe(9);
  });
});

describe('a known-tester label (gap 2)', () => {
  it('never changes the severity, and sorts the source after an unlabelled one of the same severity', async () => {
    const other = '154.47.20.3';
    // The tester is the more recent of the two, so only the label can put it second.
    const older = breachRows(other).map((r) => ({
      ...r,
      occurredAt: new Date(r.occurredAt.getTime() - 60_000),
    }));
    const { service } = world({ [TESTER]: breachRows(TESTER), [other]: older }, [
      label(`${TESTER}/32`),
    ]);
    const page = await service.list(actorWith([]), {}, context);
    const tester = page.tracks.find((t) => t.ip === TESTER);
    expect(tester).toMatchObject({
      severity: 'critical',
      breached: true,
      label: 'known_tester',
      labelNote: 'Instinct AI tester',
      allowlisted: true,
    });
    // Same facts with and without the label: the label is attached after severity is computed.
    const unlabelled = await world({ [TESTER]: breachRows(TESTER) }).service.list(
      actorWith([]),
      {},
      context,
    );
    expect(unlabelled.tracks[0]?.severity).toBe(tester?.severity);
    expect(page.tracks.map((t) => t.ip)).toEqual([other, TESTER]);
    expect(page.counts.known_tester).toBe(1);
  });

  it('never reaches an alert or the door: only the tracker reads the label', () => {
    // The alert path is the findings job (API) -> security_source_findings -> the worker detector
    // -> the digest; the door is identity's network-access. None of them may read the label.
    const here = dirname(fileURLToPath(import.meta.url));
    const root = resolve(here, '../../../../..');
    const alertAndDoorFiles = [
      'apps/api/src/modules/security-signals/source-findings.ts',
      'apps/api/src/modules/security-signals/source-findings-job.ts',
      'apps/api/src/modules/security-signals/source-findings.repository.ts',
      'apps/api/src/modules/security-signals/signal-rules.ts',
      'apps/worker/src/jobs/security-detector.ts',
      'apps/worker/src/common/database/security-signal-store.ts',
      'packages/mail/src/templates/security_alert_digest.ts',
      'apps/api/src/modules/identity/network-access/network-access-policy.ts',
      'apps/api/src/modules/identity/network-access/network-access.service.ts',
      'apps/api/src/modules/identity/network-access/network-access.repository.ts',
      'apps/api/src/modules/identity/network-access/network-access.guard.ts',
    ];
    for (const file of alertAndDoorFiles) {
      const text = readFileSync(resolve(root, file), 'utf8');
      expect(text, file).not.toMatch(/security_source_labels|source-labels|known_tester/u);
    }
  });

  it('shows blocked with the entry id from the door (gap 4)', async () => {
    const other = '154.47.20.3';
    const { service } = world({ [other]: breachRows(other) });
    const page = await service.list(actorWith([]), {}, context);
    expect(page.tracks[0]).toMatchObject({ blocked: true, blockId: 'blk-1', allowlisted: false });
  });

  it('the label service validates, 409s on overlap and audits every write', async () => {
    const labels: SourceLabel[] = [label(`${TESTER}/32`)];
    const audits: PlatformAuditInput[] = [];
    const store: SourceLabelStore = {
      list: () => Promise.resolve([...labels]),
      add: (entry, audit) => {
        const created = { id: '0193b5a0-0000-7000-8000-00000000b102', ...entry };
        labels.push(created);
        audits.push(audit(created.id));
        return Promise.resolve(created);
      },
      remove: (_id, audit) => {
        audits.push(audit);
        return Promise.resolve(true);
      },
    };
    const service = new SourceLabelsService(store, () => NOW);
    const actor = actorWith([]);
    const overlap = await service
      .add(actor, { value: '48.47.63.0/24', label: 'known_tester' }, context)
      .catch((e: unknown) => e);
    expect(overlap).toMatchObject({ status: 409 });
    await expect(
      service.add(actor, { value: '1.2.3.4', label: 'friend' }, context),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      service.add(actor, { value: '10.0.0.0/8', label: 'known_tester' }, context),
    ).rejects.toMatchObject({ status: 400 });
    const created = await service.add(
      actor,
      { value: '203.0.113.5', label: 'known_tester', note: ' QA phone ' },
      context,
    );
    expect(created).toMatchObject({ value: '203.0.113.5/32', note: 'QA phone' });
    await service.remove(actor, created.id, context);
    expect(audits.map((a) => [a.action, a.targetLabel])).toEqual([
      ['platform.source_label_added', 'known_tester:203.0.113.5/32'],
      ['platform.source_label_removed', null],
    ]);
  });
});

describe('who was targeted (gaps 5 and 9)', () => {
  it('names the accounts with their organizations on the audited detail read', async () => {
    const { service, audits, accounts } = world({ [TESTER]: breachRows(TESTER) });
    const detail = await service.get(
      actorWith(['platform.people.view', 'platform.people.security']),
      sourceHash(TESTER),
      context,
    );
    expect(audits.map((a) => a.action)).toEqual(['platform.attack_track_viewed']);
    expect(detail.accountsVisible).toBe(true);
    expect(detail.canSignOutAccounts).toBe(true);
    expect(detail.accountsTotal).toBe(2);
    expect(detail.accounts).toEqual([
      expect.objectContaining({
        displayName: 'Mona Adel',
        organizations: [{ name: 'Northwind Studio', slug: 'northwind' }],
      }),
      expect.objectContaining({ displayName: 'Ali Hassan' }),
    ]);
    expect(accounts).toHaveBeenCalledTimes(1);
    expect(detail.onLists).toEqual([]);
  });

  it('shows no names without platform.people.view, and never on the list', async () => {
    const { service, accounts } = world({ [TESTER]: breachRows(TESTER) });
    const detail = await service.get(actorWith([]), sourceHash(TESTER), context);
    expect(detail).toMatchObject({
      accounts: [],
      accountsTotal: 2,
      accountsVisible: false,
      canSignOutAccounts: false,
    });
    const page = await service.list(actorWith(['platform.people.view']), {}, context);
    expect(JSON.stringify(page)).not.toContain('Mona Adel');
    expect(accounts).not.toHaveBeenCalled();
  });

  it('says which free lists hold the address now (gap 4)', async () => {
    const other = '154.47.20.3';
    const detail = await world({ [other]: breachRows(other) }).service.get(
      actorWith([]),
      sourceHash(other),
      context,
    );
    expect(detail.onLists).toEqual(['x4b_vpn']);
  });
});

describe('paging, search, chips and totals (gap 8)', () => {
  const many = () => {
    const sources: Record<string, TrackAuthRow[]> = {};
    for (let i = 1; i <= 30; i += 1) {
      const ip = `203.0.113.${String(i)}`;
      sources[ip] = [row(ip, { occurredAt: minutesAgo(100 - i), userId: null })];
    }
    return sources;
  };

  it('pages 25 at a time with a total and a cursor, without overlap or gap', async () => {
    const { service } = world(many());
    const first = await service.list(actorWith([]), {}, context);
    expect(first.tracks).toHaveLength(25);
    expect(first.total).toBe(30);
    expect(first.counts.all).toBe(30);
    expect(first.nextCursor).not.toBeNull();
    const second = await service.list(actorWith([]), { cursor: first.nextCursor ?? '' }, context);
    expect(second.tracks).toHaveLength(5);
    expect(second.nextCursor).toBeNull();
    const ids = [...first.tracks, ...second.tracks].map((t) => t.trackId);
    expect(new Set(ids).size).toBe(30);
  });

  it('is stable under new events: page 2 reads the snapshot of page 1', async () => {
    const sources = many();
    const { service, rows, setClock } = world(sources);
    const first = await service.list(actorWith([]), {}, context);
    // After page 1: the oldest source (last on page 2) turns critical, and a new source appears.
    // Read live, both would move to the top and push page 1's last rows onto page 2 again.
    const after = new Date(NOW.getTime() + 60_000);
    rows.push(
      ...breachRows('203.0.113.1').map((r) => ({ ...r, occurredAt: after })),
      row('198.51.100.7', { occurredAt: after }),
    );
    setClock(new Date(NOW.getTime() + 120_000));
    const second = await service.list(actorWith([]), { cursor: first.nextCursor ?? '' }, context);
    const all = [...first.tracks, ...second.tracks].map((t) => t.ip);
    expect(new Set(all).size).toBe(30);
    expect(all).not.toContain('198.51.100.7');
    expect(second.total).toBe(30);
  });

  it('searches by address prefix, network owner and exact account e-mail on the server', async () => {
    const sources = {
      ...many(),
      '154.47.20.3': [row('154.47.20.3', { occurredAt: minutesAgo(1), userId: ali })],
    };
    const { service } = world(sources);
    const actor = actorWith([]);
    expect((await service.list(actor, { q: '154.47.' }, context)).total).toBe(1);
    expect((await service.list(actor, { q: 'cdn77' }, context)).total).toBe(31);
    const byEmail = await service.list(actor, { q: 'ali@northwind.test' }, context);
    expect(byEmail.tracks.map((t) => t.ip)).toEqual(['154.47.20.3']);
    expect((await service.list(actor, { q: 'nobody@x.test' }, context)).total).toBe(0);
  });

  it('filters by chip and counts every chip over the search', async () => {
    const { service } = world({ [TESTER]: breachRows(TESTER), ...many() }, [label(`${TESTER}/32`)]);
    const page = await service.list(actorWith([]), { filter: 'critical' }, context);
    expect(page.tracks.map((t) => t.ip)).toEqual([TESTER]);
    expect(page.total).toBe(1);
    expect(page.counts).toMatchObject({ all: 31, critical: 1, hosting: 31, vpn: 31, tor: 0 });
    expect(page.counts.known_tester).toBe(1);
  });

  it('rejects a bad filter, a forged cursor and a cursor from the future', () => {
    expect(() => parseTrackQuery({ filter: 'everything' }, NOW)).toThrow();
    expect(() => parseTrackQuery({ cursor: 'bm9wZQ' }, NOW)).toThrow();
    const future = encodeTrackCursor({ until: new Date(NOW.getTime() + 1), offset: 25 });
    expect(() => parseTrackQuery({ cursor: future }, NOW)).toThrow();
    const ok = encodeTrackCursor({ until: NOW, offset: 25 });
    expect(decodeTrackCursor(ok)).toEqual({ until: NOW, offset: 25 });
    expect(parseTrackQuery({ cursor: ok, q: ' 154.47 ' }, NOW)).toMatchObject({
      until: NOW,
      offset: 25,
      q: '154.47',
      limit: 25,
    });
  });

  it('orders worst first, then unlabelled, then latest, then id (a total order)', () => {
    const base = summarize({
      trackId: 'b',
      ip: '1.1.1.1',
      rows: [row('1.1.1.1', { occurredAt: minutesAgo(1) })],
      network: null,
      signals: [],
    });
    if (base === null) throw new Error('no track');
    const t = (over: Partial<TrackSummary>): TrackSummary => ({
      ...base,
      blocked: false,
      blockId: null,
      allowlisted: false,
      label: null,
      labelId: null,
      labelNote: null,
      ...over,
    });
    const sorted = [
      t({ trackId: 'd', severity: 'low' }),
      t({ trackId: '0', severity: 'critical', label: 'known_tester' }),
      t({ trackId: 'b', severity: 'critical' }),
      t({ trackId: 'a', severity: 'critical' }),
    ].sort(compareTracks);
    expect(sorted.map((x) => x.trackId)).toEqual(['a', 'b', '0', 'd']);
  });
});
