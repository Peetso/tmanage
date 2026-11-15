import { parseAutomationFlow } from '@tmanage/domain';
import type { AutomationFlow } from '@tmanage/domain';
import type { WorkerTransaction } from './worker-database.js';

/**
 * 58-C1 — the branching builder graph in force for a rule (`workflow_flow_versions`, 0350): the
 * highest version. A rule with no row is a linear rule. The stored graph is re-checked with the
 * same `parseAutomationFlow` the API saved it with; `flow` is `null` when it no longer parses, so
 * the runner records a not-run instead of guessing. Grant: `tmanage_worker` SELECT (users.sql).
 */

export interface RuleFlow {
  readonly version: number;
  readonly flow: AutomationFlow | null;
}

export async function findRuleFlow(
  tx: WorkerTransaction,
  organizationId: string,
  templateId: string,
): Promise<RuleFlow | null> {
  const rows = await tx.query<readonly { readonly version: number; readonly flow_json: unknown }[]>(
    `SELECT version, flow_json FROM workflow_flow_versions
      WHERE organization_id = ? AND template_id = ?
      ORDER BY version DESC LIMIT 1`,
    [organizationId, templateId],
  );
  const row = rows[0];
  if (row === undefined) return null;
  // JSON is a LONGTEXT alias on MariaDB: the driver hands back a string there, an object on MySQL.
  let raw: unknown = row.flow_json;
  if (typeof raw === 'string') {
    try {
      raw = JSON.parse(raw) as unknown;
    } catch {
      raw = null;
    }
  }
  const parsed = parseAutomationFlow(raw);
  return { version: Number(row.version), flow: parsed.ok ? parsed.flow : null };
}
