import { platformAuditFor } from '../platform-admin/platform-audit.service.js';
import type { PlatformRequestContext } from '../platform-admin/platform-admin.access.js';
import type { PlatformAdminActor } from '../platform-admin/platform-admin.guard.js';
import { ApiError } from '../../common/http/errors.js';
import { sourceHash } from './source-findings.js';
import {
  assertTrackId,
  compareTracks,
  encodeTrackCursor,
  matchesFilter,
  matchesSearch,
  parseTrackQuery,
  summarize,
  timeline,
  trackCounts,
  trackRows,
  TRACK_MAX_LOOKBACK_DAYS,
  TRACK_SCAN_MAX,
} from './attack-tracks.js';
import type {
  RawTrackQuery,
  TrackAccount,
  TrackDetail,
  TrackFacts,
  TrackFilter,
  TrackStep,
  TrackSummary,
} from './attack-tracks.js';
import type { AttackTrackStore } from './attack-tracks.repository.js';
import type { SourceLabelMatcher } from './source-labels.js';

/**
 * SEC-ALERTS item 6 — `GET /v1/platform/security/attack-tracks` (list) and `/:trackId`
 * (timeline). The model is `attack-tracks.ts`; this file parses, reads, audits.
 *
 * Every read writes one platform audit row before it answers (`platform.attack_tracks_viewed`,
 * `platform.attack_track_viewed`), so who looked at which source is on the platform trail. The
 * row names the track by the first 16 hex of its hash, never the address.
 *
 * SEC-TRACKER (Fable 5.2 rulings, 2026-11-22) adds, through published services only (AR-5):
 * - the source's standing at the sign-in door (blocked, allowlisted, on a free list), from the
 *   identity module's `NetworkAccessService` ({@link SourceStandingReader});
 * - the source's label (`known_tester`), from this module's own `SourceLabelsService`;
 * - the targeted accounts' names and organizations, on the detail read only, from the platform
 *   people directory ({@link AccountDirectory}), shown only to a viewer with
 *   `platform.people.view`;
 * - server-side paging, search, filter chips with counts, and totals on the list.
 */

export const ATTACK_TRACKS_SERVICE = Symbol.for('tmanage.AttackTracksService');

/** Correlation hashes owned by other modules, injected (absent = that step kind is skipped). */
export interface SourceHashers {
  /** `PublicLinkSecrets.ipHash`: the `public_link_events.ip_hash` of an address. */
  readonly publicLinkIpHash?: (ip: string) => string | null;
  /** The `rate_limit_buckets` subject hashes of an address for the UTC days around `at`. */
  readonly rateLimitSubjects?: (ip: string, at: Date) => readonly string[];
}

/** The part of identity's `NetworkAccessService` the tracker reads (gap 4). */
export interface SourceStandingReader {
  standing(
    sources: readonly { readonly ip: string; readonly asn: number | null }[],
  ): Promise<
    ReadonlyMap<
      string,
      { readonly blocked: boolean; readonly blockId: string | null; readonly allowlisted: boolean }
    >
  >;
  listsHolding(ip: string): Promise<readonly string[]>;
}

/** The part of the platform people directory the tracker reads (gaps 5 and 9). */
export interface AccountDirectory {
  accounts(userIds: readonly string[], correlationId: string): Promise<readonly TrackAccount[]>;
  userIdByEmail(email: string, correlationId: string): Promise<string | null>;
}

export interface SourceLabelReader {
  matcher(): Promise<SourceLabelMatcher>;
}

export interface AttackTrackDependencies {
  readonly standing: SourceStandingReader;
  readonly labels: SourceLabelReader;
  readonly people: AccountDirectory;
}

export interface TrackPage {
  readonly tracks: readonly TrackSummary[];
  readonly from: string;
  /** Sources matching `q` and `filter` (all pages). */
  readonly total: number;
  /** Per filter chip, over the sources matching `q` (the chips' own numbers). */
  readonly counts: Readonly<Record<TrackFilter, number>>;
  /** The next page (same `from`, `q`, `filter`), or null on the last one. */
  readonly nextCursor: string | null;
  /** More than {@link TRACK_SCAN_MAX} sources in the window: totals cover the newest ones. */
  readonly truncated: boolean;
}

const notFound = (): ApiError => new ApiError(404, 'not_found', 'The attack track was not found');

const holds = (actor: PlatformAdminActor, permission: string): boolean =>
  (actor.permissions ?? []).some((p) => p === permission);

export class AttackTracksService {
  constructor(
    private readonly store: AttackTrackStore,
    private readonly hashers: SourceHashers,
    private readonly deps: AttackTrackDependencies,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async list(
    actor: PlatformAdminActor,
    raw: RawTrackQuery,
    context: PlatformRequestContext,
  ): Promise<TrackPage> {
    const query = parseTrackQuery(raw, this.now());
    await this.store.audit(
      platformAuditFor(actor, context, {
        action: 'platform.attack_tracks_viewed',
        targetType: 'platform',
        targetId: null,
        targetLabel:
          `since ${query.from.toISOString()}` +
          (query.filter === 'all' ? '' : ` · ${query.filter}`) +
          (query.q === null ? '' : ' · search'),
        reason: null,
      }),
    );
    // One snapshot (`until`): rows after the first page's time are not read, so new events do not
    // reshuffle the pages that follow (the cursor carries `until` and the offset).
    const scanned = await this.store.recentSources(query.from, query.until, TRACK_SCAN_MAX + 1);
    const ips = scanned.slice(0, TRACK_SCAN_MAX);
    const tracks = await this.summaries(ips, query.from, query.until);
    const accountId =
      query.q !== null && query.q.includes('@')
        ? await this.deps.people.userIdByEmail(query.q, context.correlationId)
        : null;
    const searched = tracks.filter((t) => matchesSearch(t, query.q, accountId));
    const filtered = searched.filter((t) => matchesFilter(t, query.filter)).sort(compareTracks);
    const end = query.offset + query.limit;
    return {
      tracks: filtered.slice(query.offset, end),
      from: query.from.toISOString(),
      total: filtered.length,
      counts: trackCounts(searched),
      nextCursor:
        end < filtered.length ? encodeTrackCursor({ until: query.until, offset: end }) : null,
      truncated: scanned.length > TRACK_SCAN_MAX,
    };
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
    const rows = await this.store.authRows([ip], from, now);
    const network = (await this.store.networks([ip])).get(ip) ?? null;
    const signals = await this.store.signals([trackId], from, now);
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
    const facts = summarize({ trackId, ip, rows, network, signals, extraSteps: extra });
    if (facts === null) throw notFound();
    const [summary] = await this.decorate([facts]);
    if (summary === undefined) throw notFound();
    const targeted = [
      ...new Set(
        trackRows(rows)
          .map((r) => r.userId)
          .filter((id): id is string => id !== null),
      ),
    ];
    // Names only inside this audited read, and only for a viewer who may see people (gap 5).
    const accountsVisible = holds(actor, 'platform.people.view');
    const accounts = accountsVisible
      ? await this.deps.people.accounts(targeted, context.correlationId)
      : [];
    return {
      ...summary,
      timeline: timeline(rows, extra),
      accounts,
      accountsTotal: targeted.length,
      accountsVisible,
      canSignOutAccounts: holds(actor, 'platform.people.security'),
      onLists: await this.deps.standing.listsHolding(ip),
    };
  }

  /** The list's facts for `ips`, decorated with standing and label. */
  private async summaries(
    ips: readonly string[],
    from: Date,
    until: Date,
  ): Promise<readonly TrackSummary[]> {
    if (ips.length === 0) return [];
    const rows = await this.store.authRows(ips, from, until);
    const networks = await this.store.networks(ips);
    const hashes = new Map(ips.map((ip) => [sourceHash(ip), ip]));
    const signals = await this.store.signals([...hashes.keys()], from, until);
    const byIp = new Map<string, (typeof rows)[number][]>();
    for (const r of rows) byIp.set(r.ip, [...(byIp.get(r.ip) ?? []), r]);
    const facts: TrackFacts[] = [];
    for (const [trackId, ip] of hashes) {
      const summary = summarize({
        trackId,
        ip,
        rows: byIp.get(ip) ?? [],
        network: networks.get(ip) ?? null,
        signals: signals.filter((s) => s.sourceHash === trackId),
      });
      if (summary !== null) facts.push(summary);
    }
    return this.decorate(facts);
  }

  /**
   * Adds the platform's own state of each source. The label is attached after the facts are
   * computed, so it cannot reach `severity` (it only moves the source in {@link compareTracks}).
   */
  private async decorate(facts: readonly TrackFacts[]): Promise<readonly TrackSummary[]> {
    const [standing, labels] = await Promise.all([
      this.deps.standing.standing(facts.map((f) => ({ ip: f.ip, asn: f.network?.asn ?? null }))),
      this.deps.labels.matcher(),
    ]);
    return facts.map((f) => {
      const state = standing.get(f.ip);
      const label = labels.labelOf(f.ip);
      return {
        ...f,
        blocked: state?.blocked ?? false,
        blockId: state?.blockId ?? null,
        allowlisted: state?.allowlisted ?? false,
        label: label?.label ?? null,
        labelId: label?.id ?? null,
        labelNote: label?.note ?? null,
      };
    });
  }
}
