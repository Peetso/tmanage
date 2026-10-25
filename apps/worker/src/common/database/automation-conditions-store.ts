import type { WorkerTransaction } from './worker-database.js';

/**
 * C1 — the reads behind "a rule fires only when its saved conditions match".
 *
 * A rule's conditions, oldest first (`ORDER BY id`, UUIDv7), so `conditionsMatch` can take the
 * newest per field; and the current state of a work item, the `status` an "Only if" chip compares.
 * Grants: `tmanage_worker` holds SELECT on `workflow_conditions` and `work_items` (users.sql).
 */

export interface StoredCondition {
  readonly field: string;
  readonly op: string;
  readonly value: string;
}

export async function listRuleConditions(
  tx: WorkerTransaction,
  organizationId: string,
  templateId: string,
): Promise<readonly StoredCondition[]> {
  return tx.query<readonly StoredCondition[]>(
    `SELECT field, op, value FROM workflow_conditions
      WHERE organization_id = ? AND template_id = ?
      ORDER BY id`,
    [organizationId, templateId],
  );
}

/** A work item's current state, or `null` when it is gone. */
export async function findWorkItemState(
  tx: WorkerTransaction,
  organizationId: string,
  workItemId: string,
): Promise<string | null> {
  const rows = await tx.query<readonly { readonly state: string }[]>(
    `SELECT state FROM work_items WHERE organization_id = ? AND id = ?`,
    [organizationId, workItemId],
  );
  return rows[0]?.state ?? null;
}
