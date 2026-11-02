import type { WorkerDatabase } from './worker-database.js';
import type {
  ChainRow,
  NotifiedKey,
  NotifyStatus,
  PendingSignal,
  RuleSetting,
  SecuritySignalStore,
  SignalRecord,
  SignalSeverity,
} from '../../jobs/security-detector.js';

/**
 * 56-23 — the security detector's statements over the worker's pool (0263).
 *
 * Grants (users.sql, 56-23 block): SELECT on public_link_events, rate_limit_buckets, audit_heads,
 * webhook_deliveries, platform_backup_runs and platform_support_sessions (audit_events, memberships
 * and users are already held), SELECT/INSERT/UPDATE on `security_signals`, SELECT/UPDATE on
 * `platform_alert_rules`. NOT `authentication_events`: the relay never reads the security log
 * (least-privilege.db.test.ts), so `credential_stuffing` is refused and skipped (logged once)
 * until that decision changes. Every source read is bounded by an indexed time column and a
 * LIMIT; nothing here writes a source table.
 * 56-21b (no new grant): the platform admin rules read `platform_support_sessions`,
 * `platform_admin_audit_events` (SELECT, 56-11 block), `ip_lookups` (SELECT, 0280 block) and
 * `users.timezone`, all already held. `failedStepUps` counts the API's `platform.step_up_failed`
 * audit rows (R14-d), so it needs no read on `authentication_events`.
 * Dates are bound from the application clock.
 */

type Rows = readonly Record<string, unknown>[];

const LIMIT = 100;

const SQL = {
  rules: `select rule_key, enabled, threshold_json, cooldown_minutes from platform_alert_rules`,
  failedSignIns: `select ip, count(*) as n from authentication_events
    where occurred_at >= ? and outcome <> 'succeeded' and ip is not null
    group by ip having count(*) >= ? order by n desc limit ${String(LIMIT)}`,
  refusedLinks: `select organization_id, ip_hash, count(*) as n from public_link_events
    where created_at >= ? and kind = 'refused' and ip_hash is not null
    group by organization_id, ip_hash having count(*) >= ? order by n desc limit ${String(LIMIT)}`,
  buckets: `select bucket_key, hit_count from rate_limit_buckets
    where updated_at >= ? and hit_count >= ? order by hit_count desc limit ${String(LIMIT)}`,
  auditBurst: (n: number, byActor: boolean) => `select organization_id,
      ${byActor ? 'actor_user_id' : 'null as actor_user_id'}, count(*) as n
    from audit_events
    where created_at >= ? and result = 'allowed'
      and action in (${Array.from({ length: n }, () => '?').join(', ')})
    group by organization_id${byActor ? ', actor_user_id' : ''}
    having count(*) >= ? order by n desc limit ${String(LIMIT)}`,
  webhooks: `select organization_id, endpoint_id, count(*) as n from webhook_deliveries
    where attempted_at >= ? and status = 'failure'
    group by organization_id, endpoint_id having count(*) >= ? order by n desc
    limit ${String(LIMIT)}`,
  lastBackup: `select max(finished_at) as at from platform_backup_runs where status = 'ok'`,
  longSupport: `select id, organization_id from platform_support_sessions
    where ended_at is null and started_at <= ? order by started_at limit ${String(LIMIT)}`,
  changedHeads: `select organization_id, chain_seq, head_hash from audit_heads
    where updated_at >= ? order by updated_at desc limit ?`,
  chainTail: `select chain_seq, prev_hash, row_hash from audit_events
    where organization_id = ? and chain_seq is not null order by chain_seq desc limit ?`,
  supportStarts: `select admin_user_id, count(*) as n from platform_support_sessions
    where started_at >= ? group by admin_user_id having count(*) >= ? order by n desc
    limit ${String(LIMIT)}`,
  platformAccess: `select e.actor_user_id, e.created_at, u.timezone
    from platform_admin_audit_events e left join users u on u.id = e.actor_user_id
    where e.created_at >= ?
      and e.action in ('platform.step_up', 'platform.support_session_started')
    order by e.created_at desc limit ${String(LIMIT * 5)}`,
  failedStepUps: `select actor_user_id, count(*) as n from platform_admin_audit_events
    where created_at >= ? and action = 'platform.step_up_failed'
    group by actor_user_id having count(*) >= ? order by n desc limit ${String(LIMIT)}`,
  supportCountries: `select e.actor_user_id, e.created_at, l.country_code
    from platform_admin_audit_events e left join ip_lookups l on l.ip = e.ip
    where e.created_at >= ? and e.action = 'platform.support_session_started'
    order by e.created_at desc limit ${String(LIMIT)}`,
  adminCountries: `select distinct l.country_code
    from platform_admin_audit_events e join ip_lookups l on l.ip = e.ip
    where e.actor_user_id = ? and e.created_at >= ? and e.created_at < ?
      and l.country_code is not null
    limit 50`,
  upsert: `insert into security_signals
    (id, organization_id, scope_key, rule_key, severity, subject_type, subject_id, subject_key,
     source_hash, count, window_start, first_seen, last_seen, notify_status, notified_at,
     details_json)
    values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', null, ?)
    on duplicate key update count = greatest(count, values(count)), last_seen = values(last_seen),
      details_json = values(details_json)`,
  pending: `select id, organization_id, scope_key, rule_key, severity, subject_type, subject_id,
      subject_key, count, first_seen
    from security_signals where notify_status = 'pending' order by first_seen, id limit ?`,
  notifiedSince: `select rule_key, scope_key, subject_key, notified_at from security_signals
    where notify_status = 'sent' and notified_at >= ?`,
  lastDigest: `select max(notified_at) as at from security_signals where notify_status = 'sent'`,
  owners: `select u.email from memberships m join users u on u.id = m.user_id
    where m.organization_id = ? and m.role = 'owner' and m.status = 'active'
    order by u.email limit 20`,
  mark: (n: number) => `update security_signals set notify_status = ?, notified_at = ?
    where notify_status = 'pending' and id in (${Array.from({ length: n }, () => '?').join(', ')})`,
  fired: (n: number) => `update platform_alert_rules set last_fired_at = ?
    where rule_key in (${Array.from({ length: n }, () => '?').join(', ')})`,
} as const;

const num = (value: unknown): number => {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
};
const text = (value: unknown): string | null =>
  value === null || value === undefined ? null : String(value);
const date = (value: unknown): Date | null =>
  value instanceof Date
    ? value
    : typeof value === 'string' && value !== ''
      ? new Date(value)
      : null;

/** `{"count":n,"windowMinutes":m}`; a damaged row reads as disabled rather than failing the pass. */
export function parseRule(row: Record<string, unknown>): RuleSetting {
  let threshold: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(String(row['threshold_json'] ?? '{}'));
    if (parsed !== null && typeof parsed === 'object')
      threshold = parsed as Record<string, unknown>;
  } catch {
    threshold = {};
  }
  const count = num(threshold['count']);
  const windowMinutes = num(threshold['windowMinutes']);
  return {
    ruleKey: String(row['rule_key']),
    enabled: num(row['enabled']) === 1 && count >= 1 && windowMinutes >= 1,
    count: Math.max(1, Math.trunc(count)),
    windowMinutes: Math.max(1, Math.trunc(windowMinutes)),
    cooldownMinutes: Math.max(0, Math.trunc(num(row['cooldown_minutes']))),
  };
}

export function createSecuritySignalStore(database: WorkerDatabase): SecuritySignalStore {
  const read = (sql: string, params: readonly unknown[] = []) =>
    database.read((tx) => tx.query<Rows>(sql, params));
  const write = (sql: string, params: readonly unknown[]) =>
    database.transaction((tx) => tx.query(sql, params));
  return {
    async rules() {
      return (await read(SQL.rules)).map(parseRule);
    },
    async failedSignInsBySource(since, min) {
      return (await read(SQL.failedSignIns, [since, min])).map((r) => ({
        source: String(r['ip']),
        count: num(r['n']),
      }));
    },
    async refusedLinkCodes(since, min) {
      return (await read(SQL.refusedLinks, [since, min])).map((r) => ({
        organizationId: String(r['organization_id']),
        ipHash: String(r['ip_hash']),
        count: num(r['n']),
      }));
    },
    async saturatedBuckets(since, min) {
      return (await read(SQL.buckets, [since, min])).map((r) => ({
        bucketKey: String(r['bucket_key']),
        count: num(r['hit_count']),
      }));
    },
    async auditBursts(actions, since, min, byActor) {
      const rows = await read(SQL.auditBurst(actions.length, byActor), [since, ...actions, min]);
      return rows.map((r) => ({
        organizationId: String(r['organization_id']),
        actorUserId: text(r['actor_user_id']),
        count: num(r['n']),
      }));
    },
    async webhookFailures(since, min) {
      return (await read(SQL.webhooks, [since, min])).map((r) => ({
        organizationId: String(r['organization_id']),
        endpointId: String(r['endpoint_id']),
        count: num(r['n']),
      }));
    },
    async lastOkBackupAt() {
      return date((await read(SQL.lastBackup))[0]?.['at']);
    },
    async longSupportSessions(startedBefore) {
      return (await read(SQL.longSupport, [startedBefore])).map((r) => ({
        id: String(r['id']),
        organizationId: String(r['organization_id']),
      }));
    },
    async changedHeads(since, limit) {
      return (await read(SQL.changedHeads, [since, limit])).map((r) => ({
        organizationId: String(r['organization_id']),
        chainSeq: num(r['chain_seq']),
        headHash: String(r['head_hash']),
      }));
    },
    async chainTail(organizationId, limit): Promise<readonly ChainRow[]> {
      return (await read(SQL.chainTail, [organizationId, limit])).map((r) => ({
        chainSeq: num(r['chain_seq']),
        prevHash: text(r['prev_hash']),
        rowHash: text(r['row_hash']),
      }));
    },
    async supportSessionStarts(since, min) {
      return (await read(SQL.supportStarts, [since, min])).map((r) => ({
        adminUserId: String(r['admin_user_id']),
        count: num(r['n']),
      }));
    },
    async platformAccessEvents(since) {
      return (await read(SQL.platformAccess, [since])).map((r) => ({
        adminUserId: String(r['actor_user_id']),
        at: date(r['created_at']) ?? new Date(0),
        timeZone: text(r['timezone']),
      }));
    },
    async failedStepUps(since, min) {
      return (await read(SQL.failedStepUps, [since, min])).map((r) => ({
        adminUserId: String(r['actor_user_id']),
        count: num(r['n']),
      }));
    },
    async supportSessionCountries(since) {
      return (await read(SQL.supportCountries, [since])).map((r) => ({
        adminUserId: String(r['actor_user_id']),
        at: date(r['created_at']) ?? new Date(0),
        countryCode: text(r['country_code']),
      }));
    },
    async adminCountries(adminUserId, from, before) {
      return (await read(SQL.adminCountries, [adminUserId, from, before])).map((r) =>
        String(r['country_code']),
      );
    },
    async upsertSignal(signal: SignalRecord) {
      await write(SQL.upsert, [
        signal.id,
        signal.organizationId,
        signal.scopeKey,
        signal.ruleKey,
        signal.severity,
        signal.subjectType,
        signal.subjectId,
        signal.subjectKey,
        signal.sourceHash,
        signal.count,
        signal.windowStart,
        signal.seenAt,
        signal.seenAt,
        signal.details === undefined ? null : JSON.stringify(signal.details),
      ]);
    },
    async pendingSignals(limit): Promise<readonly PendingSignal[]> {
      return (await read(SQL.pending, [limit])).map((r) => ({
        id: String(r['id']),
        organizationId: text(r['organization_id']),
        scopeKey: String(r['scope_key']),
        ruleKey: String(r['rule_key']),
        severity: String(r['severity']) as SignalSeverity,
        subjectType: String(r['subject_type']),
        subjectId: text(r['subject_id']),
        subjectKey: String(r['subject_key']),
        count: num(r['count']),
        firstSeen: date(r['first_seen']) ?? new Date(0),
      }));
    },
    async notifiedSince(since): Promise<readonly NotifiedKey[]> {
      return (await read(SQL.notifiedSince, [since])).map((r) => ({
        ruleKey: String(r['rule_key']),
        scopeKey: String(r['scope_key']),
        subjectKey: String(r['subject_key']),
        notifiedAt: date(r['notified_at']) ?? new Date(0),
      }));
    },
    async lastDigestAt() {
      return date((await read(SQL.lastDigest))[0]?.['at']);
    },
    async ownerEmails(organizationId) {
      return (await read(SQL.owners, [organizationId])).map((r) => String(r['email']));
    },
    async markNotified(ids, status: NotifyStatus, at) {
      if (ids.length === 0) return;
      await write(SQL.mark(ids.length), [status, at, ...ids]);
    },
    async markRulesFired(ruleKeys, at) {
      if (ruleKeys.length === 0) return;
      await write(SQL.fired(ruleKeys.length), [at, ...ruleKeys]);
    },
  };
}
