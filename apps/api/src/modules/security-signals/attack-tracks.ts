import { ApiError } from '../../common/http/errors.js';
import type { SourceLabelKind } from './source-labels.js';
import {
  CREDENTIAL_ACTIONS,
  GUARD_ACTIONS,
  MISSING_SESSION_REASON,
  SIGN_IN_ACTIONS,
  THROTTLE_REASONS,
} from './source-findings.js';

/**
 * SEC-ALERTS item 6 — the attack tracker: every hostile trace of one source address, grouped into
 * one **track** (`trackId` = the SHA-256 `sourceHash` the detector and the findings already key
 * on, so a track and its signals join without a raw address in any key or URL).
 *
 * A track is computed on read from the rows that already exist, so it adds no table and its
 * retention is the sources' own; reads are capped at {@link TRACK_MAX_LOOKBACK_DAYS} days, the
 * 24 months of the security-report purge policy (`apps/worker/src/jobs/security-report-purge.ts`,
 * `SECURITY_REPORT_RETENTION_MONTHS`). The sources, per step kind:
 *
 * - `authentication_events`: failed credential steps, guard refusals, throttles (refused), and a
 *   successful sign-in **after** a failure from the same source (`succeeded`: the critical flag);
 * - `security_signals`: the signals keyed on the same source hash (platform rows, the findings);
 * - `public_link_events`: wrong public-link codes from the address (HMAC under the link pepper);
 * - `rate_limit_buckets`: the address's live rate-limit buckets (keys peppered per UTC day, so
 *   only today's and yesterday's are matchable, and the sweep keeps them short-lived anyway).
 *
 * The network of the address (country, ASN, owner, hosting / Tor / VPN-likely) comes from the
 * `ip_lookups` cache (`identity/geo/ip-intelligence.service.ts`).
 *
 * Platform admins only (PlatformAdminGuard + step-up), every read audited. The address is shown
 * to them (the operator needs it to block a source at the host); it never appears in a URL.
 */

export const TRACK_MAX_LOOKBACK_DAYS = 730;
export const TRACK_DEFAULT_LOOKBACK_DAYS = 7;
export const TRACK_LIST_MAX = 100;
/** SEC-TRACKER gap 8: a page is 25 sources ("Showing 25 of 212 · Show more"). */
export const TRACK_LIST_DEFAULT = 25;
export const TRACK_STEP_MAX = 500;
/**
 * The most sources one list read summarises (AS-6 bounded work). Totals and chip counts are exact
 * up to this many sources in the window; beyond it the page says `truncated: true`.
 */
export const TRACK_SCAN_MAX = 1_000;
export const TRACK_QUERY_MAX = 254;
/** The door's refusal reasons on a `network_guard` row (`network-access-policy.ts`). */
const DOOR_ACTION = 'network_guard';
const TRACK_ID = /^[0-9a-f]{64}$/u;

export type StepOutcome = 'refused' | 'throttled' | 'succeeded' | 'signal' | 'observed';
export type TrackSeverity = 'critical' | 'high' | 'medium' | 'low';

export interface TrackNetwork {
  readonly countryCode: string | null;
  readonly asn: number | null;
  readonly owner: string | null;
  readonly kind: string;
  readonly tor: boolean;
  readonly vpnLikely: boolean;
}

/** One `authentication_events` row of the source, as the tracker reads it. */
export interface TrackAuthRow {
  readonly ip: string;
  readonly userId: string | null;
  readonly action: string;
  readonly outcome: string;
  readonly reason: string | null;
  readonly userAgent: string | null;
  readonly occurredAt: Date;
  /** SEC-ALERTS item 7: the network door's layer tokens (`net.*`) and score, on its refusals. */
  readonly automationScore?: number | null;
  readonly automationReasons?: readonly string[] | null;
}

export interface TrackStep {
  readonly at: Date;
  readonly kind: 'sign_in' | 'guard' | 'signal' | 'public_link' | 'rate_limit';
  readonly action: string;
  readonly outcome: StepOutcome;
  readonly reason: string | null;
  readonly userId: string | null;
  readonly userAgent: string | null;
  readonly count?: number;
  /** The door's layer readings of a `network_guard` step (`net.a.list:x4b_datacenter`, …). */
  readonly layers?: readonly string[];
  readonly score?: number;
}

/** What the log rows of one source say, before the platform's own state is added. */
export interface TrackFacts {
  readonly trackId: string;
  readonly ip: string;
  readonly network: TrackNetwork | null;
  readonly firstSeen: Date;
  readonly lastSeen: Date;
  readonly steps: number;
  /**
   * SEC-TRACKER (must-fix 5): the sign-in attempts, `refused + throttled + succeeded` exactly, so
   * the detail line "Attempts 63 · Refused 61 · Slowed down 1 · Got in 1" always sums. `steps`
   * also counts signals, wrong link codes and rate-limit windows, which are not attempts.
   */
  readonly attempts: number;
  readonly refused: number;
  readonly throttled: number;
  readonly succeeded: number;
  /** SEC-TRACKER gap 6: refusals by the sign-in door (VPN / data centre / blocked), of `refused`. */
  readonly doorRefused: number;
  readonly accountsTargeted: readonly string[];
  readonly userAgents: readonly string[];
  readonly signals: readonly string[];
  /** A sign-in succeeded after a failure from this source: the critical flag. */
  readonly breached: boolean;
  readonly severity: TrackSeverity;
}

/** A list row: the facts plus the platform's own state of the source (gaps 2 and 4). */
export interface TrackSummary extends TrackFacts {
  /** On the platform's block list now (refused at the door first). */
  readonly blocked: boolean;
  /** The block entry, for "Unblock"; null when not blocked. */
  readonly blockId: string | null;
  /** Let through the door by the allowlist (an entry, a range or its network). */
  readonly allowlisted: boolean;
  /** `known_tester` when an admin marked the source; never changes `severity`. */
  readonly label: SourceLabelKind | null;
  readonly labelId: string | null;
  readonly labelNote: string | null;
}

/** One targeted account, named on the audited detail read only (gaps 5 and 9). */
export interface TrackAccount {
  readonly userId: string;
  readonly displayName: string;
  readonly email: string;
  readonly organizations: readonly { readonly name: string; readonly slug: string }[];
}

export interface TrackDetail extends TrackSummary {
  readonly timeline: readonly TrackStep[];
  /** At most 20, when `accountsVisible`; empty otherwise. Steps refer to them by `userId`. */
  readonly accounts: readonly TrackAccount[];
  /** Every distinct account the source tried, uncapped. */
  readonly accountsTotal: number;
  /** Decision (AR-9): the viewer holds `platform.people.view`, so names are shown. */
  readonly accountsVisible: boolean;
  /**
   * Decision (AR-9): the viewer may "Sign this account out everywhere" (`platform.people.security`),
   * through the existing `POST /v1/platform/people/:userId/sign-out` (reason required, step-up).
   */
  readonly canSignOutAccounts: boolean;
  /** SEC-TRACKER gap 4: the free block lists whose active version holds the address now. */
  readonly onLists: readonly string[];
}

const isHostile = (row: TrackAuthRow): boolean => row.outcome !== 'succeeded';

/** The outcome of one log row, in the tracker's three words. */
export function stepOutcome(row: TrackAuthRow): StepOutcome {
  if (row.outcome === 'succeeded') return 'succeeded';
  if (row.reason !== null && THROTTLE_REASONS.includes(row.reason)) return 'throttled';
  return 'refused';
}

export function authStep(row: TrackAuthRow): TrackStep {
  return {
    at: row.occurredAt,
    kind: GUARD_ACTIONS.includes(row.action) ? 'guard' : 'sign_in',
    action: row.action,
    outcome: stepOutcome(row),
    reason: row.reason,
    userId: row.userId,
    userAgent: row.userAgent,
    ...(row.action === 'network_guard' && row.automationReasons
      ? { layers: row.automationReasons, score: row.automationScore ?? 0 }
      : {}),
  };
}

/**
 * The log rows of one source that belong to its track: every hostile row, plus a successful
 * sign-in that came after the first hostile one (a success with no failure before it is ordinary
 * use and not part of an attack).
 */
export function trackRows(rows: readonly TrackAuthRow[]): TrackAuthRow[] {
  const sorted = [...rows].sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime());
  const firstHostile = sorted.find(isHostile);
  if (firstHostile === undefined) return [];
  return sorted.filter(
    (row) =>
      isHostile(row) ||
      (SIGN_IN_ACTIONS.includes(row.action) &&
        row.occurredAt.getTime() > firstHostile.occurredAt.getTime()),
  );
}

/**
 * Severity: `critical` when the source got in after failing; `high` with a high signal or a
 * credential-guessing pattern (throttled, or 5+ failed credential steps); `medium` with any other
 * signal or CSRF/guard refusals beyond signed-out polling; else `low` (one stray failure, a
 * signed-out tab).
 */
export function trackSeverity(input: {
  readonly breached: boolean;
  readonly throttled: number;
  readonly credentialFailures: number;
  readonly weightedGuard: number;
  readonly highSignal: boolean;
  readonly anySignal: boolean;
}): TrackSeverity {
  if (input.breached) return 'critical';
  if (input.highSignal || input.throttled > 0 || input.credentialFailures >= 5) return 'high';
  if (input.anySignal || input.weightedGuard > 0 || input.credentialFailures >= 2) return 'medium';
  return 'low';
}

export function summarize(input: {
  readonly trackId: string;
  readonly ip: string;
  readonly rows: readonly TrackAuthRow[];
  readonly network: TrackNetwork | null;
  readonly signals: readonly { readonly ruleKey: string; readonly severity: string }[];
  readonly extraSteps?: readonly TrackStep[];
}): TrackFacts | null {
  const rows = trackRows(input.rows);
  const extra = input.extraSteps ?? [];
  if (rows.length === 0 && extra.length === 0) return null;
  const times = [...rows.map((r) => r.occurredAt), ...extra.map((s) => s.at)].map((d) =>
    d.getTime(),
  );
  const outcomes = rows.map(stepOutcome);
  const succeeded = outcomes.filter((o) => o === 'succeeded').length;
  const throttled = outcomes.filter((o) => o === 'throttled').length;
  const credentialFailures = rows.filter(
    (r) => isHostile(r) && CREDENTIAL_ACTIONS.includes(r.action),
  ).length;
  const weightedGuard = rows.filter(
    (r) => isHostile(r) && GUARD_ACTIONS.includes(r.action) && r.reason !== MISSING_SESSION_REASON,
  ).length;
  const distinct = (values: readonly (string | null)[], max: number) =>
    [...new Set(values.filter((v): v is string => v !== null && v !== ''))].slice(0, max);
  return {
    trackId: input.trackId,
    ip: input.ip,
    network: input.network,
    firstSeen: new Date(Math.min(...times)),
    lastSeen: new Date(Math.max(...times)),
    steps: rows.length + extra.length,
    attempts: outcomes.length,
    refused: outcomes.filter((o) => o === 'refused').length,
    throttled,
    succeeded,
    doorRefused: rows.filter((r) => r.action === DOOR_ACTION && isHostile(r)).length,
    accountsTargeted: distinct(
      rows.map((r) => r.userId),
      50,
    ),
    userAgents: distinct(
      rows.map((r) => r.userAgent),
      5,
    ),
    signals: distinct(
      input.signals.map((s) => s.ruleKey),
      20,
    ),
    breached: succeeded > 0,
    severity: trackSeverity({
      breached: succeeded > 0,
      throttled,
      credentialFailures,
      weightedGuard,
      highSignal: input.signals.some((s) => s.severity === 'high'),
      anySignal: input.signals.length > 0,
    }),
  };
}

/** Every step of the track, oldest first, capped at {@link TRACK_STEP_MAX} (newest kept). */
export function timeline(
  rows: readonly TrackAuthRow[],
  extra: readonly TrackStep[],
): readonly TrackStep[] {
  const steps = [...trackRows(rows).map(authStep), ...extra].sort(
    (a, b) => a.at.getTime() - b.at.getTime(),
  );
  return steps.slice(Math.max(0, steps.length - TRACK_STEP_MAX));
}

export const TRACK_FILTERS = [
  'all',
  'critical',
  'high',
  'vpn',
  'tor',
  'hosting',
  'known_tester',
] as const;
export type TrackFilter = (typeof TRACK_FILTERS)[number];

/** Where a page starts: the snapshot time of the first page and the offset into its order. */
export interface TrackCursor {
  readonly until: Date;
  readonly offset: number;
}

export interface TrackQuery {
  readonly from: Date;
  readonly limit: number;
  /** Rows after this time are not read, so later pages keep the first page's order. */
  readonly until: Date;
  readonly offset: number;
  readonly q: string | null;
  readonly filter: TrackFilter;
}

export function encodeTrackCursor(cursor: TrackCursor): string {
  return Buffer.from(`${cursor.until.toISOString()}|${String(cursor.offset)}`, 'utf8').toString(
    'base64url',
  );
}

export function decodeTrackCursor(raw: string): TrackCursor | null {
  if (raw.length > 64) return null;
  const text = Buffer.from(raw, 'base64url').toString('utf8');
  const m = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)\|(\d{1,6})$/u.exec(text);
  if (m === null) return null;
  const until = new Date(m[1] ?? '');
  if (Number.isNaN(until.getTime())) return null;
  return { until, offset: Number(m[2]) };
}

export function matchesFilter(track: TrackSummary, filter: TrackFilter): boolean {
  switch (filter) {
    case 'all':
      return true;
    case 'critical':
    case 'high':
      return track.severity === filter;
    case 'vpn':
      return track.network?.vpnLikely === true;
    case 'tor':
      return track.network?.tor === true;
    case 'hosting':
      return track.network?.kind === 'hosting';
    case 'known_tester':
      return track.label === 'known_tester';
  }
}

/** The count of every filter chip over the searched tracks (the chips show their own count). */
export function trackCounts(
  tracks: readonly TrackSummary[],
): Readonly<Record<TrackFilter, number>> {
  const counts = Object.fromEntries(TRACK_FILTERS.map((f) => [f, 0])) as Record<
    TrackFilter,
    number
  >;
  for (const track of tracks) {
    for (const filter of TRACK_FILTERS) if (matchesFilter(track, filter)) counts[filter] += 1;
  }
  return counts;
}

/**
 * The server-side search (gap 8): an address prefix, a network owner (contains, any case), or an
 * exact account e-mail (resolved to its id by the caller: `accountId`).
 */
export function matchesSearch(
  track: TrackSummary,
  q: string | null,
  accountId: string | null,
): boolean {
  if (q === null) return true;
  const needle = q.toLowerCase();
  if (track.ip.toLowerCase().startsWith(needle)) return true;
  if ((track.network?.owner ?? '').toLowerCase().includes(needle)) return true;
  return accountId !== null && track.accountsTargeted.includes(accountId);
}

const SEVERITY_RANK: Readonly<Record<TrackSeverity, number>> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
};

/**
 * Worst first; inside one severity a labelled source (a known tester) after the unlabelled ones;
 * then the latest activity; then the id, so the order is total and pages never overlap.
 */
export function compareTracks(a: TrackSummary, b: TrackSummary): number {
  return (
    SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
    Number(a.label !== null) - Number(b.label !== null) ||
    b.lastSeen.getTime() - a.lastSeen.getTime() ||
    (a.trackId < b.trackId ? -1 : a.trackId > b.trackId ? 1 : 0)
  );
}

const invalid = (field: string, message: string): ApiError =>
  new ApiError(400, 'validation_failed', 'The query is invalid', [{ field, message }]);

export interface RawTrackQuery {
  readonly from?: string | undefined;
  readonly limit?: string | undefined;
  readonly cursor?: string | undefined;
  readonly q?: string | undefined;
  readonly filter?: string | undefined;
}

/**
 * `?from=ISO&limit=n&cursor&q&filter`; `from` defaults to 7 days back and is clamped to the
 * retention. A `cursor` (from `nextCursor`) carries the first page's snapshot time and the offset;
 * the caller sends the same `from`, `q` and `filter` with it.
 */
export function parseTrackQuery(raw: RawTrackQuery, now: Date): TrackQuery {
  const floor = now.getTime() - TRACK_MAX_LOOKBACK_DAYS * 86_400_000;
  let from = now.getTime() - TRACK_DEFAULT_LOOKBACK_DAYS * 86_400_000;
  if (raw.from !== undefined && raw.from !== '') {
    const parsed = Date.parse(raw.from);
    if (Number.isNaN(parsed)) throw invalid('from', 'an ISO 8601 date-time');
    from = parsed;
  }
  let limit = TRACK_LIST_DEFAULT;
  if (raw.limit !== undefined && raw.limit !== '') {
    limit = Number(raw.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > TRACK_LIST_MAX) {
      throw invalid('limit', `an integer 1–${String(TRACK_LIST_MAX)}`);
    }
  }
  let cursor: TrackCursor = { until: now, offset: 0 };
  if (raw.cursor !== undefined && raw.cursor !== '') {
    const decoded = decodeTrackCursor(raw.cursor);
    if (decoded === null || decoded.until.getTime() > now.getTime()) {
      throw invalid('cursor', 'a nextCursor from this list');
    }
    cursor = decoded;
  }
  const q = (raw.q ?? '').trim();
  if (q.length > TRACK_QUERY_MAX)
    throw invalid('q', `at most ${String(TRACK_QUERY_MAX)} characters`);
  const filter = raw.filter === undefined || raw.filter === '' ? 'all' : raw.filter;
  if (!(TRACK_FILTERS as readonly string[]).includes(filter)) {
    throw invalid('filter', TRACK_FILTERS.join(', '));
  }
  return {
    from: new Date(Math.max(from, floor)),
    limit,
    until: cursor.until,
    offset: cursor.offset,
    q: q === '' ? null : q,
    filter: filter as TrackFilter,
  };
}

export function assertTrackId(trackId: string): void {
  if (!TRACK_ID.test(trackId)) {
    throw new ApiError(404, 'not_found', 'The attack track was not found');
  }
}
