import { createHash } from 'node:crypto';

/**
 * SEC-ALERTS (2026-11-22) — the sign-in door's rules, evaluated in the API over
 * `authentication_events` and handed to the worker as hashed findings (0404).
 *
 * ## Why here and not in the worker
 *
 * The worker keeps no read on the security log (least privilege, D07; `least-privilege.db.test.ts`).
 * The API already reads it (database-wide SELECT; the sign-in throttle counts from it), so the
 * evaluation runs where the read already is, and only the result crosses: a rule key, a SHA-256
 * hash of the source address, counts. The worker turns a finding into a `security_signals` row
 * with its existing dedupe, cooldown and mail path (`apps/worker/src/jobs/security-detector.ts`).
 * Decision recorded in `0404_security_source_findings.sql`.
 *
 * ## The rules (pure, unit-tested in `source-findings.test.ts`)
 *
 * - **`credential_stuffing`** (high): failed credential steps (password, second factor, recovery
 *   code, re-authentication, Google/Microsoft, client magic link, password reset) from one
 *   source. Fires when the window holds `count` failures (default 5 in 10 minutes), **or** when
 *   {@link VELOCITY_FAILURES} of them fall inside {@link VELOCITY_MS} (4 in 10 s: no person types
 *   that fast; the 2026-11-21 burst was 4 wrong passwords in 1 s), **or** when the sign-in
 *   throttle itself refused the source (the limiter already judged it hostile). `pattern` is
 *   `enumeration` when the source tried {@link ENUMERATION_ACCOUNTS} or more accounts (known
 *   accounts by user id, plus attempts on addresses no account holds), else `brute_force`.
 * - **`guard_refusal_burst`** (high): HTTP guard refusals from one source, weighted. A CSRF
 *   refusal (`csrf_guard`/`csrf_failed`) and every other guard reason (a disabled account's
 *   session, a token outside its scopes or IP allowlist) weigh 1. A **`missing_session`
 *   refusal weighs 0**: the session guard writes at most one such row per address per minute
 *   (NV02 `GuardRefusalSampler`), so the table cannot tell a signed-out tab polling once a
 *   minute (2026-11-21, 197.167.175.211: 451 rows, 60 an hour) from a scanner hammering the API;
 *   counting them would page the operator for every forgotten tab. Raw request volume is the
 *   `rate_limit_saturation` rule's job. Default 4 in 10 minutes (the 2026-11-21 CSRF burst was 4
 *   in 0.3 s).
 * - **`sign_in_after_failures`** (high, item 6): a successful sign-in from a source that failed
 *   at least {@link SUCCESS_AFTER_FAILURES} credential steps in the window before it. A track
 *   that ends in a success is the one that matters most.
 *
 * Every rule reads a bounded page of the window ({@link SOURCE_ROW_LIMIT}); a storm larger than
 * the page is still a finding, because the page is ordered newest first.
 */

export const CREDENTIAL_STUFFING = 'credential_stuffing';
export const GUARD_REFUSAL_BURST = 'guard_refusal_burst';
export const SIGN_IN_AFTER_FAILURES = 'sign_in_after_failures';

/** The `authentication_events.action` tokens that present a credential. */
export const CREDENTIAL_ACTIONS: readonly string[] = [
  'password_sign_in',
  'mfa_challenge',
  'recovery_code',
  'reauthentication',
  'google_sign_in',
  'microsoft_sign_in',
  'magic_link',
  'password_set',
];

/** The actions whose `succeeded` row means "this source signed in". */
export const SIGN_IN_ACTIONS: readonly string[] = [
  'password_sign_in',
  'mfa_challenge',
  'recovery_code',
  'google_sign_in',
  'microsoft_sign_in',
  'magic_link',
];

/** `GUARD_REFUSAL_ACTIONS` in `common/http/authentication-event-recorder.ts`. */
export const GUARD_ACTIONS: readonly string[] = ['session_guard', 'csrf_guard'];
export const MISSING_SESSION_REASON = 'missing_session';
export const CSRF_FAILED_REASON = 'csrf_failed';

/** The sign-in throttle's own refusal reasons (`sign-in-abuse-control.ts`, lockout). */
export const THROTTLE_REASONS: readonly string[] = [
  'source_throttled',
  'source_account_throttled',
  'locked_out',
  'rate_limited',
];
export const UNKNOWN_ACCOUNT_REASON = 'no_such_user';

export const VELOCITY_FAILURES = 4;
export const VELOCITY_MS = 10_000;
export const ENUMERATION_ACCOUNTS = 3;
export const SUCCESS_AFTER_FAILURES = 3;
export const SOURCE_ROW_LIMIT = 5_000;

export interface RuleThreshold {
  readonly enabled: boolean;
  readonly count: number;
  readonly windowMinutes: number;
}

/** The code defaults (0404 seeds the same rows); a stored row wins. */
export const FINDING_RULE_DEFAULTS: Readonly<Record<string, RuleThreshold>> = Object.freeze({
  [CREDENTIAL_STUFFING]: { enabled: true, count: 5, windowMinutes: 10 },
  [GUARD_REFUSAL_BURST]: { enabled: true, count: 4, windowMinutes: 10 },
  [SIGN_IN_AFTER_FAILURES]: { enabled: true, count: SUCCESS_AFTER_FAILURES, windowMinutes: 60 },
});

/** One `authentication_events` row as the rules need it. `ip` is raw here and never leaves. */
export interface AuthEventRow {
  readonly ip: string;
  readonly userId: string | null;
  readonly action: string;
  readonly outcome: string;
  readonly reason: string | null;
  readonly occurredAt: Date;
}

export type FindingDetails = Readonly<Record<string, string | number>>;

export interface SourceFinding {
  readonly ruleKey: string;
  /** {@link sourceHash} of the address: the only form that leaves this module. */
  readonly sourceHash: string;
  readonly count: number;
  readonly details: FindingDetails;
  readonly firstSeen: Date;
  readonly lastSeen: Date;
}

/** The worker's spelling (`security-detector.ts` `sourceHash`): the same address, the same key. */
export function sourceHash(raw: string): string {
  return createHash('sha256').update(`tmanage.signal:${raw}`, 'utf8').digest('hex');
}

function bySource(rows: readonly AuthEventRow[]): Map<string, AuthEventRow[]> {
  const out = new Map<string, AuthEventRow[]>();
  for (const row of rows) {
    if (row.ip === '') continue;
    const list = out.get(row.ip);
    if (list === undefined) out.set(row.ip, [row]);
    else list.push(row);
  }
  for (const list of out.values()) {
    list.sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime());
  }
  return out;
}

/** The most rows inside any `spanMs`-long stretch (rows sorted oldest first). */
export function peakWithin(rows: readonly AuthEventRow[], spanMs: number): number {
  let peak = 0;
  let start = 0;
  for (let end = 0; end < rows.length; end += 1) {
    const endAt = (rows[end] as AuthEventRow).occurredAt.getTime();
    while (endAt - (rows[start] as AuthEventRow).occurredAt.getTime() > spanMs) start += 1;
    peak = Math.max(peak, end - start + 1);
  }
  return peak;
}

const isCredentialFailure = (row: AuthEventRow): boolean =>
  row.outcome !== 'succeeded' && CREDENTIAL_ACTIONS.includes(row.action);

const span = (rows: readonly AuthEventRow[]) => ({
  firstSeen: (rows[0] as AuthEventRow).occurredAt,
  lastSeen: (rows[rows.length - 1] as AuthEventRow).occurredAt,
});

/** `credential_stuffing`: brute force on one account or enumeration across many. */
export function evaluateCredentialStuffing(
  rows: readonly AuthEventRow[],
  threshold: RuleThreshold,
): SourceFinding[] {
  const out: SourceFinding[] = [];
  for (const [ip, all] of bySource(rows.filter(isCredentialFailure))) {
    const throttled = all.filter((r) => r.reason !== null && THROTTLE_REASONS.includes(r.reason));
    const peak = peakWithin(all, VELOCITY_MS);
    const fires =
      all.length >= threshold.count || peak >= VELOCITY_FAILURES || throttled.length > 0;
    if (!fires) continue;
    const accounts = new Set(all.flatMap((r) => (r.userId === null ? [] : [r.userId]))).size;
    const unknownAccounts = all.filter((r) => r.reason === UNKNOWN_ACCOUNT_REASON).length;
    out.push({
      ruleKey: CREDENTIAL_STUFFING,
      sourceHash: sourceHash(ip),
      count: all.length,
      details: {
        failures: all.length,
        accounts,
        unknownAccounts,
        throttled: throttled.length,
        peak10s: peak,
        pattern: accounts + unknownAccounts >= ENUMERATION_ACCOUNTS ? 'enumeration' : 'brute_force',
      },
      ...span(all),
    });
  }
  return out;
}

/** The weight of one guard refusal; see the module comment for why `missing_session` is 0. */
export function guardRefusalWeight(row: AuthEventRow): number {
  if (!GUARD_ACTIONS.includes(row.action) || row.outcome === 'succeeded') return 0;
  return row.reason === MISSING_SESSION_REASON ? 0 : 1;
}

/** `guard_refusal_burst`: CSRF and other guard refusals from one source. */
export function evaluateGuardRefusalBurst(
  rows: readonly AuthEventRow[],
  threshold: RuleThreshold,
): SourceFinding[] {
  const out: SourceFinding[] = [];
  const guarded = rows.filter((r) => GUARD_ACTIONS.includes(r.action) && r.outcome !== 'succeeded');
  for (const [ip, all] of bySource(guarded)) {
    const weighted = all.filter((r) => guardRefusalWeight(r) > 0);
    if (weighted.length < threshold.count) continue;
    out.push({
      ruleKey: GUARD_REFUSAL_BURST,
      sourceHash: sourceHash(ip),
      count: weighted.length,
      details: {
        csrf: weighted.filter((r) => r.reason === CSRF_FAILED_REASON).length,
        otherGuard: weighted.filter((r) => r.reason !== CSRF_FAILED_REASON).length,
        missingSession: all.length - weighted.length,
        peak10s: peakWithin(weighted, VELOCITY_MS),
      },
      ...span(weighted),
    });
  }
  return out;
}

/** `sign_in_after_failures`: a source that failed `count` times, then got in. */
export function evaluateSignInAfterFailures(
  rows: readonly AuthEventRow[],
  threshold: RuleThreshold,
): SourceFinding[] {
  const out: SourceFinding[] = [];
  for (const [ip, all] of bySource(rows)) {
    let failures = 0;
    for (const row of all) {
      if (isCredentialFailure(row)) {
        failures += 1;
        continue;
      }
      if (row.outcome !== 'succeeded' || !SIGN_IN_ACTIONS.includes(row.action)) continue;
      if (failures < threshold.count) continue;
      out.push({
        ruleKey: SIGN_IN_AFTER_FAILURES,
        sourceHash: sourceHash(ip),
        count: failures,
        details: { failuresBefore: failures, signedIn: 1 },
        firstSeen: (all[0] as AuthEventRow).occurredAt,
        lastSeen: row.occurredAt,
      });
      break;
    }
  }
  return out;
}

const EVALUATORS: Readonly<
  Record<string, (rows: readonly AuthEventRow[], threshold: RuleThreshold) => SourceFinding[]>
> = {
  [CREDENTIAL_STUFFING]: evaluateCredentialStuffing,
  [GUARD_REFUSAL_BURST]: evaluateGuardRefusalBurst,
  [SIGN_IN_AFTER_FAILURES]: evaluateSignInAfterFailures,
};

/** Every enabled rule over the rows inside its own window. */
export function evaluateSourceFindings(
  rows: readonly AuthEventRow[],
  thresholds: ReadonlyMap<string, RuleThreshold>,
  now: Date,
): SourceFinding[] {
  const out: SourceFinding[] = [];
  for (const [ruleKey, evaluate] of Object.entries(EVALUATORS)) {
    const threshold = thresholds.get(ruleKey) ?? FINDING_RULE_DEFAULTS[ruleKey];
    if (threshold === undefined || !threshold.enabled) continue;
    const from = now.getTime() - threshold.windowMinutes * 60_000;
    out.push(
      ...evaluate(
        rows.filter((r) => r.occurredAt.getTime() >= from),
        threshold,
      ),
    );
  }
  return out;
}

/** The longest enabled window: how far back the job reads. */
export function longestWindowMinutes(thresholds: ReadonlyMap<string, RuleThreshold>): number {
  let longest = 1;
  for (const ruleKey of Object.keys(EVALUATORS)) {
    const threshold = thresholds.get(ruleKey) ?? FINDING_RULE_DEFAULTS[ruleKey];
    if (threshold?.enabled === true) longest = Math.max(longest, threshold.windowMinutes);
  }
  return longest;
}

/** The finding's dedupe bucket: the rule window it fell in (the worker buckets the same way). */
export function windowStartOf(at: Date, windowMinutes: number): Date {
  const ms = Math.max(1, windowMinutes) * 60_000;
  return new Date(Math.floor(at.getTime() / ms) * ms);
}

/** `{"count":n,"windowMinutes":m}` plus `enabled`; damaged JSON reads as the code default. */
export function parseThreshold(
  ruleKey: string,
  enabled: boolean,
  thresholdJson: string,
): RuleThreshold | undefined {
  const fallback = FINDING_RULE_DEFAULTS[ruleKey];
  try {
    const parsed = JSON.parse(thresholdJson) as Record<string, unknown>;
    const count = Number(parsed['count']);
    const windowMinutes = Number(parsed['windowMinutes']);
    if (
      Number.isInteger(count) &&
      count >= 1 &&
      Number.isInteger(windowMinutes) &&
      windowMinutes >= 1
    ) {
      return { enabled, count, windowMinutes };
    }
  } catch {
    // fall through to the default
  }
  return fallback === undefined ? undefined : { ...fallback, enabled };
}
