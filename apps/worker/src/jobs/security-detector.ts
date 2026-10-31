import { createHash } from 'node:crypto';
import { uuidv7 } from '@tmanage/domain';
import type { Mailer } from '@tmanage/mail';

/**
 * 56-23 — the security detector (0263): every 5 minutes, cheap indexed reads over a bounded
 * window of the raw security rows become deduplicated `security_signals`, and the pending ones
 * leave in at most one alert e-mail per 15 minutes.
 *
 * ## Detect
 *
 * Each rule below reads its own window (`platform_alert_rules.threshold_json`: `count` and
 * `windowMinutes`) and returns candidates at or above the count. A candidate becomes one row per
 * (scope, rule, subject, rule window): `scope_key` is the organization id or `platform`,
 * `subject_key` the subject id, the source hash or `-`. A second pass in the same window only
 * raises `count` and `last_seen`, so a storm is one row, not hundreds. Sources are read-only
 * here; a raw IP is hashed (SHA-256) before it is stored and never leaves this process.
 * Impossible travel is deferred (no GeoIP database is bundled) and has no evaluator. Credential
 * stuffing is deferred too (the worker has no read on `authentication_events`, by design): a
 * deferred rule is never attempted, even when its row says enabled, so it logs nothing.
 *
 * ## Notify
 *
 * - **Batching** — nothing is mailed while the last digest is younger than 15 minutes; pending
 *   rows wait for the next window and leave together (alert-storm rule D).
 * - **Cooldown** — a pending row whose (rule, scope, subject) was mailed within the rule's
 *   `cooldown_minutes` is marked `suppressed`, not mailed again.
 * - **Audience** — `ALERT_EMAILS` get one platform digest of everything; each organization's
 *   active owners get their own organization's `high` rows only, never a platform (NULL-org) row
 *   and never another organization's.
 */

export const SECURITY_DETECTOR_INTERVAL_MS = 5 * 60 * 1000;
export const DIGEST_INTERVAL_MS = 15 * 60 * 1000;
export const PENDING_BATCH = 200;
export const DIGEST_TEMPLATE_KEY = 'security_alert_digest';
const MINUTE_MS = 60_000;
const CHAIN_TAIL = 50;
const CHANGED_HEADS = 50;

export type SignalSeverity = 'low' | 'medium' | 'high';
export type NotifyStatus = 'pending' | 'sent' | 'suppressed' | 'none';

export interface RuleSetting {
  readonly ruleKey: string;
  readonly enabled: boolean;
  readonly count: number;
  readonly windowMinutes: number;
  readonly cooldownMinutes: number;
}

export interface SignalCandidate {
  readonly organizationId: string | null;
  readonly subjectType: string;
  readonly subjectId: string | null;
  readonly sourceHash: string | null;
  readonly count: number;
  readonly details?: Readonly<Record<string, string | number>>;
}

export interface SignalRecord extends SignalCandidate {
  readonly id: string;
  readonly scopeKey: string;
  readonly ruleKey: string;
  readonly severity: SignalSeverity;
  readonly subjectKey: string;
  readonly windowStart: Date;
  readonly seenAt: Date;
}

export interface PendingSignal {
  readonly id: string;
  readonly organizationId: string | null;
  readonly scopeKey: string;
  readonly ruleKey: string;
  readonly severity: SignalSeverity;
  readonly subjectType: string;
  readonly subjectId: string | null;
  readonly subjectKey: string;
  readonly count: number;
  readonly firstSeen: Date;
}

export interface NotifiedKey {
  readonly ruleKey: string;
  readonly scopeKey: string;
  readonly subjectKey: string;
  readonly notifiedAt: Date;
}

export interface ChainRow {
  readonly chainSeq: number;
  readonly prevHash: string | null;
  readonly rowHash: string | null;
}

/** The statements the detector needs. `security-signal-store.ts` over the pool; faked in tests. */
export interface SecuritySignalStore {
  rules(): Promise<readonly RuleSetting[]>;
  /** Failed sign-ins per raw source IP since `since`, `>= min`. The IP is hashed by the caller. */
  failedSignInsBySource(
    since: Date,
    min: number,
  ): Promise<readonly { source: string; count: number }[]>;
  refusedLinkCodes(
    since: Date,
    min: number,
  ): Promise<readonly { organizationId: string; ipHash: string; count: number }[]>;
  saturatedBuckets(
    since: Date,
    min: number,
  ): Promise<readonly { bucketKey: string; count: number }[]>;
  auditBursts(
    actions: readonly string[],
    since: Date,
    min: number,
    byActor: boolean,
  ): Promise<readonly { organizationId: string; actorUserId: string | null; count: number }[]>;
  webhookFailures(
    since: Date,
    min: number,
  ): Promise<readonly { organizationId: string; endpointId: string; count: number }[]>;
  lastOkBackupAt(): Promise<Date | null>;
  longSupportSessions(
    startedBefore: Date,
  ): Promise<readonly { id: string; organizationId: string }[]>;
  changedHeads(
    since: Date,
    limit: number,
  ): Promise<readonly { organizationId: string; chainSeq: number; headHash: string }[]>;
  /** The newest `limit` chained rows of one organization, highest `chain_seq` first. */
  chainTail(organizationId: string, limit: number): Promise<readonly ChainRow[]>;
  upsertSignal(signal: SignalRecord): Promise<void>;
  pendingSignals(limit: number): Promise<readonly PendingSignal[]>;
  notifiedSince(since: Date): Promise<readonly NotifiedKey[]>;
  lastDigestAt(): Promise<Date | null>;
  ownerEmails(organizationId: string): Promise<readonly string[]>;
  markNotified(ids: readonly string[], status: NotifyStatus, at: Date): Promise<void>;
  markRulesFired(ruleKeys: readonly string[], at: Date): Promise<void>;
}

/** The digest's words: `packages/mail/src/templates/security_alert_digest.ts`. */
export type ComposeDigest = (input: {
  readonly audience: 'platform' | 'organization';
  readonly signals: readonly PendingSignal[];
  readonly generatedAt: Date;
}) => { readonly subject: string; readonly text: string };

export function sourceHash(raw: string): string {
  return createHash('sha256').update(`tmanage.signal:${raw}`, 'utf8').digest('hex');
}

const PERMISSION_ACTIONS = [
  'membership.role_changed',
  'project_membership.role_changed',
  'client_membership.role_changed',
  'custom_role.created',
  'custom_role.updated',
  'custom_role.deleted',
] as const;
const EXPORT_ACTIONS = ['audit.exported', 'usage.exported', 'privacy_export.requested'] as const;

/** Link continuity of the newest chained rows against the head (56-11 integrity, cheap form). */
export function chainBroken(
  head: { readonly chainSeq: number; readonly headHash: string },
  tail: readonly ChainRow[],
): boolean {
  if (head.chainSeq === 0) return false;
  const top = tail[0];
  if (top === undefined || top.chainSeq !== head.chainSeq || top.rowHash !== head.headHash) {
    return true;
  }
  for (let i = 0; i + 1 < tail.length; i += 1) {
    const newer = tail[i];
    const older = tail[i + 1];
    if (newer === undefined || older === undefined) break;
    if (newer.chainSeq !== older.chainSeq + 1 || newer.prevHash !== older.rowHash) return true;
  }
  return false;
}

interface Rule {
  readonly key: string;
  readonly severity: SignalSeverity;
  /** Set = the rule cannot run in this process; it is never attempted, even when enabled. */
  readonly deferred?: string;
  detect(
    store: SecuritySignalStore,
    setting: RuleSetting,
    now: Date,
  ): Promise<readonly SignalCandidate[]>;
}

const since = (now: Date, setting: RuleSetting): Date =>
  new Date(now.getTime() - setting.windowMinutes * MINUTE_MS);

const orgBurst =
  (actions: readonly string[], byActor: boolean): Rule['detect'] =>
  async (store, setting, now) =>
    (await store.auditBursts(actions, since(now, setting), setting.count, byActor)).map((row) => ({
      organizationId: row.organizationId,
      subjectType: byActor ? 'user' : 'organization',
      subjectId: byActor ? row.actorUserId : row.organizationId,
      sourceHash: null,
      count: row.count,
    }));

/** v1 catalog; labels and the API's validation live in `modules/security-signals/signal-rules.ts`. */
export const DETECTOR_RULES: readonly Rule[] = [
  {
    key: 'credential_stuffing',
    severity: 'high',
    // The worker keeps no read on `authentication_events` (least privilege, 56-23); 0266 turns
    // the seeded row off. The evaluator stays for an API-side or narrow-view detector.
    deferred:
      'worker has no read on the security log by design; needs an API-side or narrow-view detector',
    detect: async (store, setting, now) =>
      (await store.failedSignInsBySource(since(now, setting), setting.count)).map((row) => ({
        organizationId: null,
        subjectType: 'source',
        subjectId: null,
        sourceHash: sourceHash(row.source),
        count: row.count,
      })),
  },
  {
    key: 'public_link_guessing',
    severity: 'medium',
    detect: async (store, setting, now) =>
      (await store.refusedLinkCodes(since(now, setting), setting.count)).map((row) => ({
        organizationId: row.organizationId,
        subjectType: 'source',
        subjectId: null,
        sourceHash: row.ipHash,
        count: row.count,
      })),
  },
  {
    key: 'rate_limit_saturation',
    severity: 'medium',
    detect: async (store, setting, now) =>
      (await store.saturatedBuckets(since(now, setting), setting.count)).map((row) => ({
        organizationId: null,
        subjectType: 'rate_limit_bucket',
        subjectId: null,
        sourceHash: sourceHash(row.bucketKey),
        count: row.count,
        details: { policy: row.bucketKey.split(':')[0] ?? '' },
      })),
  },
  { key: 'invitation_burst', severity: 'medium', detect: orgBurst(['invitation.issued'], false) },
  { key: 'permission_churn', severity: 'high', detect: orgBurst(PERMISSION_ACTIONS, false) },
  { key: 'mass_export', severity: 'high', detect: orgBurst(EXPORT_ACTIONS, true) },
  {
    key: 'webhook_breaker',
    severity: 'low',
    detect: async (store, setting, now) =>
      (await store.webhookFailures(since(now, setting), setting.count)).map((row) => ({
        organizationId: row.organizationId,
        subjectType: 'webhook_endpoint',
        subjectId: row.endpointId,
        sourceHash: null,
        count: row.count,
      })),
  },
  {
    key: 'backup_missed',
    severity: 'high',
    detect: async (store, setting, now) => {
      const last = await store.lastOkBackupAt();
      if (last !== null && last.getTime() >= since(now, setting).getTime()) return [];
      const hours = last === null ? -1 : Math.floor((now.getTime() - last.getTime()) / 3_600_000);
      return [
        {
          organizationId: null,
          subjectType: 'backup',
          subjectId: null,
          sourceHash: null,
          count: 1,
          details: { hoursSinceOk: hours },
        },
      ];
    },
  },
  {
    key: 'audit_chain_break',
    severity: 'high',
    detect: async (store, setting, now) => {
      const out: SignalCandidate[] = [];
      for (const head of await store.changedHeads(since(now, setting), CHANGED_HEADS)) {
        const tail = await store.chainTail(head.organizationId, CHAIN_TAIL);
        if (!chainBroken(head, tail)) continue;
        out.push({
          organizationId: head.organizationId,
          subjectType: 'audit_chain',
          subjectId: null,
          sourceHash: null,
          count: 1,
          details: { chainSeq: head.chainSeq },
        });
      }
      return out;
    },
  },
  {
    key: 'support_session_long',
    severity: 'medium',
    detect: async (store, setting, now) =>
      (await store.longSupportSessions(since(now, setting))).map((row) => ({
        organizationId: row.organizationId,
        subjectType: 'support_session',
        subjectId: row.id,
        sourceHash: null,
        count: 1,
      })),
  },
];

function windowStart(now: Date, windowMinutes: number): Date {
  const ms = Math.max(1, windowMinutes) * MINUTE_MS;
  return new Date(Math.floor(now.getTime() / ms) * ms);
}

export interface DetectorDeps {
  readonly store: SecuritySignalStore;
  readonly mailer: Mailer | null;
  readonly alertEmails: readonly string[];
  readonly composeDigest: ComposeDigest;
  readonly now?: () => Date;
  readonly newId?: () => string;
  /** One failing rule (a refused grant, say) is reported and skipped; the others still run. */
  readonly onRuleError?: (ruleKey: string, error: unknown) => void;
}

const reportedRuleErrors = new Set<string>();

/** Default: log a rule's failure once per process, not every 5 minutes. */
function logRuleErrorOnce(ruleKey: string, error: unknown): void {
  if (reportedRuleErrors.has(ruleKey)) return;
  reportedRuleErrors.add(ruleKey);
  console.error(`[worker] security rule ${ruleKey} skipped`, error);
}

export interface DetectorResult {
  readonly detected: number;
  readonly mailed: number;
  readonly suppressed: number;
}

export async function detectSignals(deps: DetectorDeps, now: Date): Promise<number> {
  const settings = new Map((await deps.store.rules()).map((rule) => [rule.ruleKey, rule]));
  let detected = 0;
  for (const rule of DETECTOR_RULES) {
    const setting = settings.get(rule.key);
    if (rule.deferred !== undefined || setting === undefined || !setting.enabled) continue;
    let candidates: readonly SignalCandidate[];
    try {
      candidates = await rule.detect(deps.store, setting, now);
    } catch (error) {
      (deps.onRuleError ?? logRuleErrorOnce)(rule.key, error);
      continue;
    }
    for (const candidate of candidates) {
      await deps.store.upsertSignal({
        ...candidate,
        id: (deps.newId ?? uuidv7)(),
        scopeKey: candidate.organizationId ?? 'platform',
        ruleKey: rule.key,
        severity: rule.severity,
        subjectKey: candidate.subjectId ?? candidate.sourceHash ?? '-',
        windowStart: windowStart(now, setting.windowMinutes),
        seenAt: now,
      });
      detected += 1;
    }
  }
  return detected;
}

const keyOf = (s: { ruleKey: string; scopeKey: string; subjectKey: string }): string =>
  `${s.ruleKey}|${s.scopeKey}|${s.subjectKey}`;

export async function dispatchSignals(
  deps: DetectorDeps,
  now: Date,
): Promise<{ mailed: number; suppressed: number }> {
  const { store } = deps;
  const last = await store.lastDigestAt();
  if (last !== null && now.getTime() - last.getTime() < DIGEST_INTERVAL_MS) {
    return { mailed: 0, suppressed: 0 };
  }
  const pending = await store.pendingSignals(PENDING_BATCH);
  if (pending.length === 0) return { mailed: 0, suppressed: 0 };

  const rules = new Map((await store.rules()).map((rule) => [rule.ruleKey, rule]));
  const longest = Math.max(0, ...[...rules.values()].map((rule) => rule.cooldownMinutes));
  const lastSent = new Map<string, number>();
  for (const key of await store.notifiedSince(new Date(now.getTime() - longest * MINUTE_MS))) {
    lastSent.set(keyOf(key), Math.max(lastSent.get(keyOf(key)) ?? 0, key.notifiedAt.getTime()));
  }
  const send: PendingSignal[] = [];
  const quiet: string[] = [];
  for (const signal of pending) {
    const rule = rules.get(signal.ruleKey);
    const sent = lastSent.get(keyOf(signal));
    const cooling =
      sent !== undefined && now.getTime() - sent < (rule?.cooldownMinutes ?? 0) * MINUTE_MS;
    if (rule === undefined || !rule.enabled || cooling) quiet.push(signal.id);
    else send.push(signal);
  }
  if (quiet.length > 0) await store.markNotified(quiet, 'suppressed', now);
  if (send.length === 0) return { mailed: 0, suppressed: quiet.length };

  let mailed = 0;
  const mail = async (to: string, audience: 'platform' | 'organization', rows: PendingSignal[]) => {
    if (deps.mailer === null) return;
    const body = deps.composeDigest({ audience, signals: rows, generatedAt: now });
    await deps.mailer.send({ to, ...body, templateKey: DIGEST_TEMPLATE_KEY });
    mailed += 1;
  };
  for (const to of deps.alertEmails) await mail(to, 'platform', send);
  const byOrg = new Map<string, PendingSignal[]>();
  for (const signal of send) {
    if (signal.organizationId === null || signal.severity !== 'high') continue;
    byOrg.set(signal.organizationId, [...(byOrg.get(signal.organizationId) ?? []), signal]);
  }
  for (const [organizationId, rows] of byOrg) {
    for (const to of await store.ownerEmails(organizationId)) await mail(to, 'organization', rows);
  }
  await store.markNotified(
    send.map((signal) => signal.id),
    mailed > 0 ? 'sent' : 'none',
    now,
  );
  if (mailed > 0) await store.markRulesFired([...new Set(send.map((s) => s.ruleKey))], now);
  return { mailed, suppressed: quiet.length };
}

export async function runSecurityDetector(deps: DetectorDeps): Promise<DetectorResult> {
  const now = (deps.now ?? (() => new Date()))();
  const detected = await detectSignals(deps, now);
  const { mailed, suppressed } = await dispatchSignals(deps, now);
  return { detected, mailed, suppressed };
}

/** Loop mode: one pass now and one every 5 minutes until the signal aborts; failures are logged. */
export async function runSecurityDetectorLoop(
  deps: DetectorDeps,
  signal: AbortSignal,
  onError: (error: unknown) => void = (error) => {
    console.error('[worker] security detector failed', error);
  },
  intervalMs = SECURITY_DETECTOR_INTERVAL_MS,
): Promise<void> {
  while (!signal.aborted) {
    try {
      const result = await runSecurityDetector(deps);
      if (result.mailed > 0) {
        console.warn(`[worker] security signals: ${String(result.mailed)} alert mail(s) queued`);
      }
    } catch (error) {
      onError(error);
    }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, intervalMs);
      signal.addEventListener(
        'abort',
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
    });
  }
}
