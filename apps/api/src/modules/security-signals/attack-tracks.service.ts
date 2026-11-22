import { platformAuditFor } from '../platform-admin/platform-audit.service.js';
import type { PlatformRequestContext } from '../platform-admin/platform-admin.access.js';
import type { PlatformAdminActor } from '../platform-admin/platform-admin.guard.js';
import { ApiError } from '../../common/http/errors.js';
import { sourceHash } from './source-findings.js';
import {
  assertTrackId,
  parseTrackQuery,
  summarize,
  timeline,
  TRACK_MAX_LOOKBACK_DAYS,
} from './attack-tracks.js';
import type { TrackDetail, TrackStep, TrackSummary } from './attack-tracks.js';
import type { AttackTrackStore } from './attack-tracks.repository.js';

/**
 * SEC-ALERTS item 6 — `GET /v1/platform/security/attack-tracks` (list) and `/:trackId`
 * (timeline). The model is `attack-tracks.ts`; this file parses, reads, audits.
 *
 * Every read writes one platform audit row before it answers (`platform.attack_tracks_viewed`,
 * `platform.attack_track_viewed`), so who looked at which source is on the platform trail. The
 * row names the track by the first 16 hex of its hash, never the address.
 */

export const ATTACK_TRACKS_SERVICE = Symbol.for('tmanage.AttackTracksService');

/** Correlation hashes owned by other modules, injected (absent = that step kind is skipped). */
export interface SourceHashers {
  /** `PublicLinkSecrets.ipHash`: the `public_link_events.ip_hash` of an address. */
  readonly publicLinkIpHash?: (ip: string) => string | null;
  /** The `rate_limit_buckets` subject hashes of an address for the UTC days around `at`. */
  readonly rateLimitSubjects?: (ip: string, at: Date) => readonly string[];
}

export interface TrackPage {
  readonly tracks: readonly TrackSummary[];
  readonly from: string;
}

const notFound = (): ApiError => new ApiError(404, 'not_found', 'The attack track was not found');

export class AttackTracksService {
  constructor(
    private readonly store: AttackTrackStore,
    private readonly hashers: SourceHashers = {},
    private readonly now: () => Date = () => new Date(),
  ) {}

  async list(
    actor: PlatformAdminActor,
    raw: { readonly from?: string | undefined; readonly limit?: string | undefined },
    context: PlatformRequestContext,
  ): Promise<TrackPage> {
    const query = parseTrackQuery(raw, this.now());
    await this.store.audit(
      platformAuditFor(actor, context, {
        action: 'platform.attack_tracks_viewed',
        targetType: 'platform',
        targetId: null,
        targetLabel: `since ${query.from.toISOString()}`,
        reason: null,
      }),
    );
    const ips = await this.store.recentSources(query.from, query.limit);
    const rows = await this.store.authRows(ips, query.from);
    const networks = await this.store.networks(ips);
    const hashes = new Map(ips.map((ip) => [sourceHash(ip), ip]));
    const signals = await this.store.signals([...hashes.keys()], query.from);
    const tracks: TrackSummary[] = [];
    for (const [trackId, ip] of hashes) {
      const summary = summarize({
        trackId,
        ip,
        rows: rows.filter((r) => r.ip === ip),
        network: networks.get(ip) ?? null,
        signals: signals.filter((s) => s.sourceHash === trackId),
      });
      if (summary !== null) tracks.push(summary);
    }
    tracks.sort((a, b) => b.lastSeen.getTime() - a.lastSeen.getTime());
    return { tracks, from: query.from.toISOString() };
  }

  async get(
    actor: PlatformAdminActor,
    trackId: string,
    context: PlatformRequestContext,
  ): Promise<TrackDetail> {
    assertTrackId(trackId);
    const now = this.now();
    const from = new Date(now.getTime() - TRACK_MAX_LOOKBACK_DAYS * 86_400_000);
    await this.store.audit(
      platformAuditFor(actor, context, {
        action: 'platform.attack_track_viewed',
        targetType: 'platform',
        targetId: null,
        targetLabel: `track ${trackId.slice(0, 16)}`,
        reason: null,
      }),
    );
    // A hash cannot be inverted: the address is found among the sources of the retention window.
    const ip = (await this.store.allSources(from)).find(
      (candidate) => sourceHash(candidate) === trackId,
    );
    if (ip === undefined) throw notFound();
    const rows = await this.store.authRows([ip], from);
    const network = (await this.store.networks([ip])).get(ip) ?? null;
    const signals = await this.store.signals([trackId], from);
    const extra: TrackStep[] = signals.map((s) => ({
      at: s.lastSeen,
      kind: 'signal',
      action: s.ruleKey,
      outcome: 'signal',
      reason: s.severity,
      userId: null,
      userAgent: null,
      count: s.count,
    }));
    const linkHash = this.hashers.publicLinkIpHash?.(ip) ?? null;
    if (linkHash !== null) extra.push(...(await this.store.publicLinkRefusals(linkHash, from)));
    const subjects = this.hashers.rateLimitSubjects?.(ip, now) ?? [];
    extra.push(...(await this.store.rateLimitHits(subjects)));
    const summary = summarize({ trackId, ip, rows, network, signals, extraSteps: extra });
    if (summary === null) throw notFound();
    return { ...summary, timeline: timeline(rows, extra) };
  }
}
