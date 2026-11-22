import { ApiError } from '../../common/http/errors.js';
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
export const TRACK_LIST_DEFAULT = 50;
export const TRACK_STEP_MAX = 500;
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

export interface TrackSummary {
  readonly trackId: string;
  readonly ip: string;
  readonly network: TrackNetwork | null;
  readonly firstSeen: Date;
  readonly lastSeen: Date;
  readonly steps: number;
  readonly refused: number;
  readonly throttled: number;
  readonly succeeded: number;
  readonly accountsTargeted: readonly string[];
  readonly userAgents: readonly string[];
  readonly signals: readonly string[];
  /** A sign-in succeeded after a failure from this source: the critical flag. */
  readonly breached: boolean;
  readonly severity: TrackSeverity;
}

export interface TrackDetail extends TrackSummary {
  readonly timeline: readonly TrackStep[];
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
}): TrackSummary | null {
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
    refused: outcomes.filter((o) => o === 'refused').length,
    throttled,
    succeeded,
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

export interface TrackQuery {
  readonly from: Date;
  readonly limit: number;
}

const invalid = (field: string, message: string): ApiError =>
  new ApiError(400, 'validation_failed', 'The query is invalid', [{ field, message }]);

/** `?from=ISO&limit=n`; `from` defaults to 7 days back and is clamped to the retention. */
export function parseTrackQuery(
  raw: { readonly from?: string | undefined; readonly limit?: string | undefined },
  now: Date,
): TrackQuery {
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
  return { from: new Date(Math.max(from, floor)), limit };
}

export function assertTrackId(trackId: string): void {
  if (!TRACK_ID.test(trackId)) {
    throw new ApiError(404, 'not_found', 'The attack track was not found');
  }
}
