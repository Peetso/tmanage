import { conditionsMatch, uuidv7 } from '@tmanage/domain';
import type { WorkerDatabase, WorkerTransaction } from './worker-database.js';
import { listRuleConditions } from './automation-conditions-store.js';
import { findRuleFlow } from './automation-flow-store.js';
import { projectOwners, runFlowRule, runRule } from '../../consumers/automation-runs.js';
import type { TriggerObject } from '../../consumers/automation-runs.js';
import { deliverHeldRuns, listWeekendRules } from './weekend-hold-store.js';
import {
  DUE_SOON_TRIGGER,
  dueInDaysOf,
  type DueSoonRule,
  type DueSoonSweepStore,
} from '../../jobs/due-soon-sweeper.js';

/**
 * C1 (0230): the due-soon sweep's statements, over the worker's own pool.
 *
 * The window and the claim day are the database clock's (`current_timestamp(3)`, `CURRENT_DATE`),
 * so firing never turns on the worker host's clock. Grants (scripts/db/users.sql): SELECT on
 * `workflow_templates`, `workflow_conditions`, `work_items`, `workflow_due_soon_fires`; INSERT on
 * `workflow_due_soon_fires`, `workflow_runs`, `notifications`.
 */

/** The most items one rule fires for in one sweep; the next sweep takes the rest. */
const SWEEP_BATCH = 500;

interface RuleRow {
  readonly id: string;
  readonly organization_id: string;
  readonly name: string;
  readonly trigger_kind: string;
  readonly action_kind: string;
  readonly config_json: unknown;
}

interface ItemRow {
  readonly id: string;
  readonly project_id: string;
  readonly owner_user_id: string | null;
  readonly state: string;
}

interface InsertResult {
  readonly affectedRows: number;
}

/** `config_json` (or `detail_json`) is a string on MariaDB and an object on MySQL. */
export function configOf(raw: unknown): Readonly<Record<string, unknown>> {
  let config: unknown = raw;
  if (typeof raw === 'string') {
    try {
      config = JSON.parse(raw);
    } catch {
      config = null;
    }
  }
  return config !== null && typeof config === 'object' && !Array.isArray(config)
    ? (config as Record<string, unknown>)
    : {};
}

export async function listDueSoonRules(tx: WorkerTransaction): Promise<readonly DueSoonRule[]> {
  const rows = await tx.query<readonly RuleRow[]>(
    `SELECT id, organization_id, name, trigger_kind, action_kind, config_json
       FROM workflow_templates
      WHERE trigger_kind = ? AND enabled = 1 AND deleted_at IS NULL
      ORDER BY organization_id, id`,
    [DUE_SOON_TRIGGER],
  );
  return rows.map((row) => {
    const config = configOf(row.config_json);
    return {
      id: row.id,
      organizationId: row.organization_id,
      name: row.name,
      triggerKind: row.trigger_kind,
      actionKind: row.action_kind,
      skipWeekends: config['skipWeekends'] === true,
      alsoTell: typeof config['alsoTell'] === 'string' ? config['alsoTell'] : 'none',
      dueInDays: dueInDaysOf(config),
    };
  });
}

/**
 * Fire one rule: its organization's open items due within the window, each checked against the
 * rule's conditions, claimed for today, and run. Returns how many items the rule ran for.
 */
export async function fireDueSoonRule(
  tx: WorkerTransaction,
  rule: DueSoonRule,
  now: Date = new Date(),
): Promise<number> {
  const org = rule.organizationId;
  const items = await tx.query<readonly ItemRow[]>(
    `SELECT id, project_id, owner_user_id, state
       FROM work_items
      WHERE organization_id = ?
        AND deleted_at IS NULL
        AND state NOT IN ('done', 'archived')
        AND due_at IS NOT NULL
        AND due_at >= current_timestamp(3)
        AND due_at < CURRENT_DATE + INTERVAL ? DAY
      ORDER BY due_at, id
      LIMIT ${String(SWEEP_BATCH)}`,
    [org, rule.dueInDays + 1],
  );
  if (items.length === 0) return 0;

  const conditions = await listRuleConditions(tx, org, rule.id);
  // 58-C1: a rule saved in the builder runs its graph; a linear rule runs as before.
  const saved = await findRuleFlow(tx, org, rule.id);
  let fired = 0;
  for (const item of items) {
    const event = { object_type: 'work_item', project_id: item.project_id, status: item.state };
    if (!conditionsMatch(conditions, event)) continue;

    const claimId = uuidv7();
    const claim = await tx.query<InsertResult>(
      `INSERT IGNORE INTO workflow_due_soon_fires
         (id, organization_id, template_id, work_item_id, fire_date)
       VALUES (?, ?, ?, ?, CURRENT_DATE)`,
      [claimId, org, rule.id, item.id],
    );
    if (claim.affectedRows !== 1) continue; // Already fired for this item today.

    const object: TriggerObject = {
      objectType: 'work_item',
      objectId: item.id,
      projectId: item.project_id,
      ownerIds:
        item.owner_user_id !== null
          ? [item.owner_user_id]
          : await projectOwners(tx, org, item.project_id),
    };
    const fire = { id: claimId, organizationId: org };
    if (saved === null) await runRule(fire, tx, rule, object, now);
    else await runFlowRule(fire, tx, rule, saved, object, event);
    fired += 1;
  }
  return fired;
}

/**
 * Bind the sweep's statements to a worker pool as its store port: one transaction per rule. Gap 10:
 * the same sweep delivers weekend-held runs on Sunday morning (`weekend-hold-store.ts`).
 */
export function createDueSoonSweepStore(database: WorkerDatabase): DueSoonSweepStore {
  return {
    listRules: () => database.transaction((tx) => listDueSoonRules(tx)),
    fireRule: (rule) => database.transaction((tx) => fireDueSoonRule(tx, rule)),
    deliverHeldRuns: async () => {
      const rules = await database.transaction((tx) => listWeekendRules(tx));
      let delivered = 0;
      for (const rule of rules) {
        delivered += await database.transaction((tx) => deliverHeldRuns(tx, rule));
      }
      return delivered;
    },
  };
}
