import type { RowDataPacket } from 'mysql2';
import { uuidv7 } from '@tmanage/domain';
import type { TenantDatabase } from '../../common/database/tenant-context.js';
import {
  CREDENTIAL_ACTIONS,
  FINDING_RULE_DEFAULTS,
  GUARD_ACTIONS,
  SOURCE_ROW_LIMIT,
  parseThreshold,
} from './source-findings.js';
import type { AuthEventRow, RuleThreshold, SourceFinding } from './source-findings.js';

/**
 * SEC-ALERTS — the statements of the source-findings job, all on the identity path (every table
 * here is GLOBAL: `authentication_events`, `platform_alert_rules`, `security_source_findings`).
 *
 * - The read is bounded twice: by `occurred_at >= ?` on `ix_authentication_events_occurred` and
 *   by {@link SOURCE_ROW_LIMIT}, newest first. Only rows with an address are read.
 * - The upsert is the anomaly guard (DA-1): the primary key `(rule_key, source_hash,
 *   window_start)` makes two copies of the job (RT-2, a restart overlap) write one row, and
 *   `greatest()` means a later, shorter page never lowers a count already found.
 * - The prune keeps the hand-off table small; the durable record is `security_signals`.
 */

const RULE_KEYS = Object.keys(FINDING_RULE_DEFAULTS);
const READ_RULES = `select rule_key, enabled, threshold_json from platform_alert_rules
  where rule_key in (${RULE_KEYS.map(() => '?').join(', ')})`;
const actionList = [...CREDENTIAL_ACTIONS, ...GUARD_ACTIONS];
const READ_EVENTS = `select ip, user_id, action, outcome, reason, occurred_at
  from authentication_events
  where occurred_at >= ? and ip is not null
    and action in (${actionList.map(() => '?').join(', ')})
  order by occurred_at desc limit ${String(SOURCE_ROW_LIMIT)}`;
const UPSERT = `insert into security_source_findings
  (rule_key, source_hash, window_start, count, details_json, first_seen, last_seen)
  values (?, ?, ?, ?, ?, ?, ?)
  on duplicate key update count = greatest(count, values(count)),
    details_json = values(details_json), last_seen = greatest(last_seen, values(last_seen))`;
const PRUNE = `delete from security_source_findings where last_seen < ? limit 1000`;

export const FINDINGS_RETENTION_MS = 2 * 24 * 3_600_000;

export interface SourceFindingsStore {
  thresholds(): Promise<Map<string, RuleThreshold>>;
  authEvents(since: Date): Promise<readonly AuthEventRow[]>;
  writeFindings(
    findings: readonly (SourceFinding & { readonly windowStart: Date })[],
  ): Promise<void>;
  prune(before: Date): Promise<void>;
}

const toDate = (value: unknown): Date => (value instanceof Date ? value : new Date(String(value)));

export class SourceFindingsRepository implements SourceFindingsStore {
  constructor(private readonly database: TenantDatabase) {}

  async thresholds(): Promise<Map<string, RuleThreshold>> {
    const rows = await this.database.identityRead(
      { correlationId: uuidv7(), tables: ['platform_alert_rules'] },
      (runner) => runner.query<RowDataPacket[]>(READ_RULES, RULE_KEYS),
    );
    const out = new Map<string, RuleThreshold>();
    for (const row of rows) {
      const key = String(row['rule_key']);
      const parsed = parseThreshold(
        key,
        Number(row['enabled']) === 1,
        String(row['threshold_json']),
      );
      if (parsed !== undefined) out.set(key, parsed);
    }
    return out;
  }

  async authEvents(since: Date): Promise<readonly AuthEventRow[]> {
    const rows = await this.database.identityRead(
      { correlationId: uuidv7(), tables: ['authentication_events'] },
      (runner) => runner.query<RowDataPacket[]>(READ_EVENTS, [since, ...actionList]),
    );
    return rows.map((row) => ({
      ip: String(row['ip']),
      userId: row['user_id'] === null ? null : String(row['user_id']),
      action: String(row['action']),
      outcome: String(row['outcome']),
      reason: row['reason'] === null ? null : String(row['reason']),
      occurredAt: toDate(row['occurred_at']),
    }));
  }

  async writeFindings(
    findings: readonly (SourceFinding & { readonly windowStart: Date })[],
  ): Promise<void> {
    if (findings.length === 0) return;
    await this.database.identityTransaction(
      { correlationId: uuidv7(), tables: ['security_source_findings'] },
      async (tx) => {
        for (const f of findings) {
          await tx.query(UPSERT, [
            f.ruleKey,
            f.sourceHash,
            f.windowStart,
            f.count,
            JSON.stringify(f.details),
            f.firstSeen,
            f.lastSeen,
          ]);
        }
      },
    );
  }

  async prune(before: Date): Promise<void> {
    await this.database.identityTransaction(
      { correlationId: uuidv7(), tables: ['security_source_findings'] },
      (tx) => tx.query(PRUNE, [before]),
    );
  }
}
