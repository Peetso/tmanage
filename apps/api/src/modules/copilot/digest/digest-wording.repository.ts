import type { ResultSetHeader } from 'mysql2';
import type {
  BootstrapQueryRunner,
  QueryRows,
  TenantContext,
  TenantQueryRunner,
} from '../../../common/database/tenant-context.js';

/**
 * 62-28 (0396) — `ai_digest_wordings`. Bound SQL; the organization from the verified context on
 * every tenant statement; times bound by the job (never the database clock). The two bootstrap
 * reads only name organizations, so each is then worked under its own service context.
 */

export type DigestWordingStatus = 'submitted' | 'ready' | 'rejected' | 'failed';

export interface DigestWordingRow {
  readonly id: string;
  readonly linesSha256: string;
  readonly status: DigestWordingStatus;
  readonly batchId: string | null;
  readonly taskId: string | null;
  readonly callId: string | null;
}

export interface SubmittedWording {
  readonly id: string;
  readonly linesSha256: string;
  readonly lineCount: number;
  readonly batchId: string;
  readonly customId: string;
  readonly taskId: string;
  readonly callId: string;
  readonly model: string;
  readonly at: Date;
}

const rowOf = (row: Record<string, unknown>): DigestWordingRow => ({
  id: String(row['id']),
  linesSha256: String(row['lines_sha256']),
  status: String(row['status']) as DigestWordingStatus,
  batchId: row['batch_id'] === null ? null : String(row['batch_id']),
  taskId: row['task_id'] === null ? null : String(row['task_id']),
  callId: row['call_id'] === null ? null : String(row['call_id']),
});

const COLUMNS = 'id, lines_sha256, status, batch_id, task_id, call_id';

export class DigestWordingRepository {
  /** Organizations with a finished signals sweep (the only ones with a briefing to word). */
  async organizationsWithSweeps(runner: BootstrapQueryRunner): Promise<readonly string[]> {
    const rows = await runner.query<QueryRows>(
      'SELECT organization_id FROM work_signal_sweeps ORDER BY organization_id',
    );
    return rows.map((row) => String(row['organization_id']));
  }

  /** Organizations with a wording still in a batch. */
  async organizationsWithSubmitted(runner: BootstrapQueryRunner): Promise<readonly string[]> {
    const rows = await runner.query<QueryRows>(
      "SELECT DISTINCT organization_id FROM ai_digest_wordings WHERE status = 'submitted' ORDER BY organization_id",
    );
    return rows.map((row) => String(row['organization_id']));
  }

  async findByLines(
    runner: TenantQueryRunner,
    context: TenantContext,
    linesSha256: string,
  ): Promise<DigestWordingRow | null> {
    const rows = await runner.execute<QueryRows>(
      `SELECT ${COLUMNS} FROM ai_digest_wordings
        WHERE organization_id = ? AND lines_sha256 = ? LIMIT 1`,
      [context.organizationId, linesSha256],
    );
    return rows.length === 0 ? null : rowOf(rows[0]!);
  }

  async submitted(
    runner: TenantQueryRunner,
    context: TenantContext,
  ): Promise<readonly DigestWordingRow[]> {
    const rows = await runner.execute<QueryRows>(
      `SELECT ${COLUMNS} FROM ai_digest_wordings
        WHERE organization_id = ? AND status = 'submitted' ORDER BY id LIMIT 100`,
      [context.organizationId],
    );
    return rows.map(rowOf);
  }

  /** `false` when a row for the same section already exists (another pass won). */
  async insertSubmitted(
    runner: TenantQueryRunner,
    context: TenantContext,
    row: SubmittedWording,
  ): Promise<boolean> {
    const result = await runner.execute<ResultSetHeader>(
      `INSERT IGNORE INTO ai_digest_wordings
        (id, organization_id, lines_sha256, line_count, status, batch_id, custom_id, task_id,
         call_id, model, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'submitted', ?, ?, ?, ?, ?, ?, ?)`,
      [
        row.id,
        context.organizationId,
        row.linesSha256,
        row.lineCount,
        row.batchId,
        row.customId,
        row.taskId,
        row.callId,
        row.model,
        row.at,
        row.at,
      ],
    );
    return result.affectedRows === 1;
  }

  /** submitted → ready / rejected / failed, once. */
  async conclude(
    runner: TenantQueryRunner,
    context: TenantContext,
    id: string,
    outcome: {
      readonly status: Exclude<DigestWordingStatus, 'submitted'>;
      readonly body: string | null;
      readonly reason: string | null;
    },
    at: Date,
  ): Promise<boolean> {
    const result = await runner.execute<ResultSetHeader>(
      `UPDATE ai_digest_wordings SET status = ?, body = ?, reason_code = ?, updated_at = ?
        WHERE organization_id = ? AND id = ? AND status = 'submitted'`,
      [outcome.status, outcome.body, outcome.reason, at, context.organizationId, id],
    );
    return result.affectedRows === 1;
  }
}
