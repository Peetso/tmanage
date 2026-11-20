import type { ResultSetHeader } from 'mysql2';
import type {
  QueryRows,
  TenantContext,
  TenantQueryRunner,
} from '../../common/database/tenant-context.js';
import type { AiUndoEntry } from './ai-undo.js';

/**
 * 62-11 part 2 — the change state of one AI task in `ai_tasks.undo_json` (0382, copilot-owned):
 * the card waiting for a confirm, the changes that ran and what their undo needs. Ids and captured
 * values only; the frozen arguments live in the signed card, never in this row.
 *
 * Every move is one guarded UPDATE whose `WHERE` names the state it leaves (the shape of
 * `ai-budget.repository.ts`), so two confirms of one card, or two undos of one task, serialise on
 * the row and exactly one wins. Tenant-bound (DA-12): `organization_id = ?` and the member's own
 * `membership_id = ?` on every statement. JSON_EXTRACT / JSON_UNQUOTE are in MariaDB 10.2+ and
 * MySQL 5.7+.
 */

export type AiChangeStateName =
  'card' | 'confirming' | 'done' | 'confirm_failed' | 'undoing' | 'undone' | 'undo_failed';

export interface AiChangeState {
  readonly v: 1;
  readonly state: AiChangeStateName;
  /** The card waiting for a confirm (`card` / `confirming`), else `null`. */
  readonly card: string | null;
  /** When the last change ran (the 15-minute undo window starts here). */
  readonly doneAt: string | null;
  readonly entries: readonly AiUndoEntry[];
  /** A change ran that has no inverse: the task cannot be undone as a whole. */
  readonly cannotUndo: boolean;
}

export interface AiTaskChangeRow {
  readonly status: string;
  readonly change: AiChangeState | null;
}

export const AI_CHANGE_SQL = {
  read: `select status, undo_json from ai_tasks
    where organization_id = ? and id = ? and membership_id = ? limit 1`,
  claimCard: `update ai_tasks set undo_json = ?
    where organization_id = ? and id = ? and membership_id = ? and status = 'completed'
      and json_unquote(json_extract(undo_json, '$.state')) = 'card'
      and json_unquote(json_extract(undo_json, '$.card')) = ?`,
  move: `update ai_tasks set undo_json = ?
    where organization_id = ? and id = ? and membership_id = ?
      and json_unquote(json_extract(undo_json, '$.state')) = ?`,
} as const;

/** The stored state, or `null` for a missing or unreadable one (never trusted to run anything). */
export function parseChangeState(raw: unknown): AiChangeState | null {
  let value: unknown = raw;
  if (typeof raw === 'string') {
    try {
      value = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;
  if (record['v'] !== 1 || typeof record['state'] !== 'string') return null;
  return {
    v: 1,
    state: record['state'] as AiChangeStateName,
    card: typeof record['card'] === 'string' ? record['card'] : null,
    doneAt: typeof record['doneAt'] === 'string' ? record['doneAt'] : null,
    entries: Array.isArray(record['entries']) ? (record['entries'] as AiUndoEntry[]) : [],
    cannotUndo: record['cannotUndo'] === true,
  };
}

const changed = (result: ResultSetHeader): boolean => result.affectedRows === 1;

export class AiChangeRepository {
  async read(
    runner: TenantQueryRunner,
    context: TenantContext,
    taskId: string,
  ): Promise<AiTaskChangeRow | null> {
    const rows = await runner.execute<QueryRows>(AI_CHANGE_SQL.read, [
      context.organizationId,
      taskId,
      context.membershipId,
    ]);
    const row = rows[0];
    if (row === undefined) return null;
    return { status: String(row['status']), change: parseChangeState(row['undo_json']) };
  }

  /** `card` → `confirming` for this card id; `false` when another confirm won or it is gone. */
  async claimCard(
    runner: TenantQueryRunner,
    context: TenantContext,
    taskId: string,
    cardId: string,
    next: AiChangeState,
  ): Promise<boolean> {
    return changed(
      await runner.execute<ResultSetHeader>(AI_CHANGE_SQL.claimCard, [
        JSON.stringify(next),
        context.organizationId,
        taskId,
        context.membershipId,
        cardId,
      ]),
    );
  }

  /** `from` → `next.state`; `false` when the row is no longer in `from`. */
  async move(
    runner: TenantQueryRunner,
    context: TenantContext,
    taskId: string,
    from: AiChangeStateName,
    next: AiChangeState,
  ): Promise<boolean> {
    return changed(
      await runner.execute<ResultSetHeader>(AI_CHANGE_SQL.move, [
        JSON.stringify(next),
        context.organizationId,
        taskId,
        context.membershipId,
        from,
      ]),
    );
  }
}
