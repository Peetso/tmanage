import type { RowDataPacket } from 'mysql2';
import { uuidv7 } from '@tmanage/domain';
import type { SqlParameter, TenantDatabase } from '../../common/database/tenant-context.js';
import { insertPlatformAudit } from '../platform-admin/platform-admin.repository.js';
import type { PlatformAuditInput } from '../platform-admin/platform-admin.repository.js';
import type { TrackAuthRow, TrackNetwork, TrackStep } from './attack-tracks.js';

/**
 * SEC-ALERTS item 6 — the attack tracker's reads. Read-only except the audit row.
 *
 * - `authentication_events`, `ip_lookups`, `rate_limit_buckets` and `platform_admin_audit_events`
 *   are GLOBAL: identity path. The per-source reads ride `ix_authentication_events_ip_occurred`
 *   (0280); the source list rides `ix_authentication_events_occurred`.
 * - `security_signals` and `public_link_events` are tenant tables read across organizations for
 *   platform triage: `bootstrapRead` with an audited reason, the `security-signals.repository.ts`
 *   precedent. `public_link_events` has no `ip_hash` index, so it is read only on the detail
 *   route, bounded by the window and a LIMIT.
 */

const SOURCE_LIMIT = 20_000;
const ROW_LIMIT = 5_000;
/** SEC-TRACKER: sources per `authRows` statement, so a 1,000-source list read is 10 statements. */
const IP_BATCH = 100;

const SIGNAL_REASON =
  'platform attack tracker: the signals of one source hash across organizations, ids and counts only';
const LINK_REASON =
  'platform attack tracker: wrong public-link codes of one source hash across organizations';

const toDate = (value: unknown): Date => (value instanceof Date ? value : new Date(String(value)));
const text = (value: unknown): string | null =>
  value === null || value === undefined ? null : String(value);
const marks = (n: number): string => Array.from({ length: n }, () => '?').join(', ');

export interface AttackTrackStore {
  /** Sources with a hostile row in `[from, until]`, newest activity first. */
  recentSources(from: Date, until: Date, limit: number): Promise<readonly string[]>;
  /** Every distinct source with a hostile row since `from` (to resolve a track id). */
  allSources(from: Date): Promise<readonly string[]>;
  /** The sources' rows in `[from, until]`, read in batches of {@link IP_BATCH} sources. */
  authRows(ips: readonly string[], from: Date, until: Date): Promise<readonly TrackAuthRow[]>;
  networks(ips: readonly string[]): Promise<ReadonlyMap<string, TrackNetwork>>;
  /** Signals of the hashes seen since `from` and first raised by `until`. */
  signals(
    hashes: readonly string[],
    from: Date,
    until: Date,
  ): Promise<
    readonly {
      sourceHash: string;
      ruleKey: string;
      severity: string;
      lastSeen: Date;
      count: number;
    }[]
  >;
  publicLinkRefusals(ipHash: string, from: Date): Promise<readonly TrackStep[]>;
  rateLimitHits(subjectHashes: readonly string[]): Promise<readonly TrackStep[]>;
  audit(input: PlatformAuditInput): Promise<void>;
}

/** `automation_reasons_json` (a JSON column: mysql2 returns it parsed, a string on MariaDB). */
function reasonList(value: unknown): readonly string[] | null {
  let parsed: unknown = value;
  if (typeof value === 'string') {
    try {
      parsed = JSON.parse(value);
    } catch {
      return null;
    }
  }
  return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : null;
}

export class AttackTrackRepository implements AttackTrackStore {
  constructor(private readonly database: TenantDatabase) {}

  private identity(
    tables: string[],
    correlationId: string,
    sql: string,
    params: readonly SqlParameter[],
  ): Promise<RowDataPacket[]> {
    return this.database.identityRead({ correlationId, tables }, (runner) =>
      runner.query<RowDataPacket[]>(sql, params),
    );
  }

  async recentSources(from: Date, until: Date, limit: number): Promise<readonly string[]> {
    const rows = await this.identity(
      ['authentication_events'],
      uuidv7(),
      `select ip, max(occurred_at) as last_at from authentication_events
        where occurred_at >= ? and occurred_at <= ? and outcome <> 'succeeded' and ip is not null
        group by ip order by last_at desc limit ?`,
      [from, until, limit],
    );
    return rows.map((r) => String(r['ip']));
  }

  async allSources(from: Date): Promise<readonly string[]> {
    const rows = await this.identity(
      ['authentication_events'],
      uuidv7(),
      `select distinct ip from authentication_events
        where occurred_at >= ? and outcome <> 'succeeded' and ip is not null
        limit ${String(SOURCE_LIMIT)}`,
      [from],
    );
    return rows.map((r) => String(r['ip']));
  }

  async authRows(
    ips: readonly string[],
    from: Date,
    until: Date,
  ): Promise<readonly TrackAuthRow[]> {
    const rows: RowDataPacket[] = [];
    for (let i = 0; i < ips.length; i += IP_BATCH) {
      const batch = ips.slice(i, i + IP_BATCH);
      rows.push(
        ...(await this.identity(
          ['authentication_events'],
          uuidv7(),
          `select ip, user_id, action, outcome, reason, user_agent, occurred_at,
              automation_score, automation_reasons_json
            from authentication_events
            where ip in (${marks(batch.length)}) and occurred_at >= ? and occurred_at <= ?
            order by occurred_at desc limit ${String(ROW_LIMIT)}`,
          [...batch, from, until],
        )),
      );
    }
    return rows.map((r) => ({
      ip: String(r['ip']),
      userId: text(r['user_id']),
      action: String(r['action']),
      outcome: String(r['outcome']),
      reason: text(r['reason']),
      userAgent: text(r['user_agent']),
      occurredAt: toDate(r['occurred_at']),
      automationScore: r['automation_score'] === null ? null : Number(r['automation_score']),
      automationReasons: reasonList(r['automation_reasons_json']),
    }));
  }

  async networks(ips: readonly string[]): Promise<ReadonlyMap<string, TrackNetwork>> {
    if (ips.length === 0) return new Map();
    const rows = await this.identity(
      ['ip_lookups'],
      uuidv7(),
      `select ip, country_code, asn, network_owner, network_kind, is_tor, vpn_or_proxy
        from ip_lookups where ip in (${marks(ips.length)})`,
      [...ips],
    );
    return new Map(
      rows.map((r) => [
        String(r['ip']),
        {
          countryCode: text(r['country_code']),
          asn: r['asn'] === null || r['asn'] === undefined ? null : Number(r['asn']),
          owner: text(r['network_owner']),
          kind: String(r['network_kind'] ?? 'unknown'),
          tor: Number(r['is_tor']) === 1,
          vpnLikely: String(r['vpn_or_proxy']) === 'likely',
        },
      ]),
    );
  }

  async signals(hashes: readonly string[], from: Date, until: Date) {
    const rows: RowDataPacket[] = [];
    for (let i = 0; i < hashes.length; i += IP_BATCH) {
      const batch = hashes.slice(i, i + IP_BATCH);
      rows.push(
        ...(await this.database.bootstrapRead(
          { correlationId: uuidv7(), reason: SIGNAL_REASON, tables: ['security_signals'] },
          (runner) =>
            runner.query<RowDataPacket[]>(
              `select source_hash, rule_key, severity, last_seen, count from security_signals
                where source_hash in (${marks(batch.length)}) and last_seen >= ?
                  and first_seen <= ?
                order by last_seen desc limit 500`,
              [...batch, from, until],
            ),
        )),
      );
    }
    return rows.map((r) => ({
      sourceHash: String(r['source_hash']),
      ruleKey: String(r['rule_key']),
      severity: String(r['severity']),
      lastSeen: toDate(r['last_seen']),
      count: Number(r['count']),
    }));
  }

  async publicLinkRefusals(ipHash: string, from: Date): Promise<readonly TrackStep[]> {
    const rows = await this.database.bootstrapRead(
      { correlationId: uuidv7(), reason: LINK_REASON, tables: ['public_link_events'] },
      (runner) =>
        runner.query<RowDataPacket[]>(
          `select kind, user_agent, created_at from public_link_events
            where ip_hash = ? and created_at >= ? and kind = 'refused'
            order by created_at desc limit 100`,
          [ipHash, from],
        ),
    );
    return rows.map((r) => ({
      at: toDate(r['created_at']),
      kind: 'public_link' as const,
      action: 'public_link_code',
      outcome: 'refused' as const,
      reason: 'wrong_code',
      userId: null,
      userAgent: text(r['user_agent']),
    }));
  }

  async rateLimitHits(subjectHashes: readonly string[]): Promise<readonly TrackStep[]> {
    if (subjectHashes.length === 0) return [];
    const rows = await this.identity(
      ['rate_limit_buckets'],
      uuidv7(),
      `select bucket_key, window_start, hit_count from rate_limit_buckets
        where ${subjectHashes.map(() => 'bucket_key like ?').join(' or ')}
        order by window_start desc limit 50`,
      subjectHashes.map((h) => `%:ip:_:${h}`),
    );
    return rows.map((r) => ({
      at: toDate(r['window_start']),
      kind: 'rate_limit' as const,
      action: String(r['bucket_key']).split(':')[0] ?? 'rate_limit',
      outcome: 'observed' as const,
      reason: `window_${String(r['bucket_key']).split(':')[2] ?? ''}`,
      userId: null,
      userAgent: null,
      count: Number(r['hit_count']),
    }));
  }

  async audit(input: PlatformAuditInput): Promise<void> {
    await this.database.identityTransaction(
      { correlationId: input.correlationId, tables: ['platform_admin_audit_events'] },
      (tx) => insertPlatformAudit(tx, input),
    );
  }
}
