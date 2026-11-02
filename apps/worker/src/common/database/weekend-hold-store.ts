import type { WorkerTransaction } from './worker-database.js';
import type { AutomationRule } from './collaboration-store.js';
import { findDocumentFacts, findWorkItemFacts, insertWorkflowRun } from './collaboration-store.js';
import { configOf } from './due-soon-store.js';
import { notifyAndRecord, projectOwners } from '../../consumers/automation-runs.js';
import { isCalendarHoldReleased } from '../../jobs/due-soon-sweeper.js';
import { readOrganizationCalendar } from './working-calendar-store.js';
import type { TriggerObject } from '../../consumers/automation-runs.js';

/**
 * Gap 10 — runs held for the weekend are delivered on Sunday morning.
 *
 * A rule with "Skip weekends" records a Friday or Saturday run as `held_for_weekend` (company
 * timezone), naming the triggering event and object. The due-soon sweep, which a host cron already
 * runs, then calls {@link deliverHeldRuns} for every enabled rule that still skips weekends: once
 * the company's clock reads Sunday 08:00 or later, each held run younger than
 * {@link HELD_RUN_MAX_AGE_DAYS} is sent the way it would have been on the day — the owners as they
 * are now, access re-checked, the same notification dedupe key — and a new run row names the held
 * run (`heldRunId`) it closes.
 *
 * Idempotent: a held run that a later run already names is skipped, so a second sweep on Sunday
 * appends nothing, and the notice's dedupe key makes even a racing sweep tell nobody twice. A rule
 * switched off (or deleted) before Sunday delivers nothing. Grants (scripts/db/users.sql): SELECT
 * on `workflow_templates`, `organizations`, `workflow_runs`; INSERT on `workflow_runs`,
 * `notifications` — all already the worker's.
 */

/** A held run older than this is not delivered any more (Friday 00:00 → Monday night). */
export const HELD_RUN_MAX_AGE_DAYS = 4;

/** An enabled "Skip weekends" rule, with its company's timezone. */
export interface WeekendRule extends AutomationRule {
  readonly organizationId: string;
  readonly timeZone: string;
}

interface WeekendRuleRow {
  readonly id: string;
  readonly organization_id: string;
  readonly name: string;
  readonly trigger_kind: string;
  readonly action_kind: string;
  readonly config_json: unknown;
  readonly timezone: string | null;
}

interface RunRow {
  readonly id: string;
  readonly detail_json: unknown;
}

/** A held run as the delivery reads it back from its detail. */
export interface HeldRun {
  readonly runId: string;
  readonly eventId: string;
  readonly objectType: string;
  readonly objectId: string;
  readonly projectId: string;
}

export async function listWeekendRules(tx: WorkerTransaction): Promise<readonly WeekendRule[]> {
  const rows = await tx.query<readonly WeekendRuleRow[]>(
    `SELECT t.id, t.organization_id, t.name, t.trigger_kind, t.action_kind, t.config_json,
            o.timezone
       FROM workflow_templates t
       JOIN organizations o ON o.id = t.organization_id
      WHERE t.enabled = 1 AND t.deleted_at IS NULL
      ORDER BY t.organization_id, t.id`,
  );
  const rules: WeekendRule[] = [];
  for (const row of rows) {
    const config = configOf(row.config_json);
    if (config['skipWeekends'] !== true) continue;
    rules.push({
      id: row.id,
      organizationId: row.organization_id,
      name: row.name,
      triggerKind: row.trigger_kind,
      actionKind: row.action_kind,
      skipWeekends: true,
      alsoTell: typeof config['alsoTell'] === 'string' ? config['alsoTell'] : 'none',
      timeZone: typeof row.timezone === 'string' && row.timezone !== '' ? row.timezone : 'UTC',
    });
  }
  return rules;
}

/**
 * The rule's held runs that no later run has delivered yet, oldest first. Pure over the rows, so the
 * suite can feed it a history.
 */
export function undeliveredHeldRuns(rows: readonly RunRow[]): readonly HeldRun[] {
  const delivered = new Set<string>();
  const held: HeldRun[] = [];
  for (const row of rows) {
    const detail = configOf(row.detail_json);
    const closes = detail['heldRunId'];
    if (typeof closes === 'string') delivered.add(closes);
    if (detail['reason'] !== 'held_for_weekend') continue;
    const eventId = detail['heldEventId'];
    const objectType = detail['heldObjectType'];
    const objectId = detail['heldObjectId'];
    const projectId = detail['heldProjectId'];
    // A run held before gap 10 recorded no object: there is nothing to send, so it stays held.
    if (
      typeof eventId !== 'string' ||
      typeof objectType !== 'string' ||
      typeof objectId !== 'string' ||
      typeof projectId !== 'string'
    ) {
      continue;
    }
    held.push({ runId: row.id, eventId, objectType, objectId, projectId });
  }
  return held.filter((run) => !delivered.has(run.runId));
}

/** Who owns the held object now — the same reading the runner uses when the trigger fires. */
async function heldObject(
  tx: WorkerTransaction,
  organizationId: string,
  run: HeldRun,
): Promise<TriggerObject | null> {
  const base = { objectType: run.objectType, objectId: run.objectId };
  if (run.objectType === 'work_item') {
    const item = await findWorkItemFacts(tx, organizationId, run.objectId);
    if (item === null) return null;
    return {
      ...base,
      projectId: item.projectId,
      ownerIds:
        item.ownerUserId !== null
          ? [item.ownerUserId]
          : await projectOwners(tx, organizationId, item.projectId),
    };
  }
  if (run.objectType === 'document') {
    const document = await findDocumentFacts(tx, organizationId, run.objectId);
    if (document === null) return null;
    return { ...base, projectId: document.projectId, ownerIds: [document.createdByUserId] };
  }
  return {
    ...base,
    projectId: run.projectId,
    ownerIds: await projectOwners(tx, organizationId, run.projectId),
  };
}

/**
 * Deliver one rule's held runs if its company's clock says the weekend is over. Returns how many
 * held runs it closed.
 */
export async function deliverHeldRuns(
  tx: WorkerTransaction,
  rule: WeekendRule,
  now: Date = new Date(),
): Promise<number> {
  const org = rule.organizationId;
  // R14: released on the company calendar's next working day from its day start; no row = Sunday 08:00.
  const calendar = await readOrganizationCalendar(tx, org);
  if (!isCalendarHoldReleased(calendar, now, rule.timeZone)) return 0;
  const rows = await tx.query<readonly RunRow[]>(
    `SELECT id, detail_json
       FROM workflow_runs
      WHERE organization_id = ? AND template_id = ?
        AND started_at >= current_timestamp(3) - INTERVAL ? DAY
      ORDER BY started_at, id`,
    [org, rule.id, HELD_RUN_MAX_AGE_DAYS],
  );
  let delivered = 0;
  for (const run of undeliveredHeldRuns(rows)) {
    const object = await heldObject(tx, org, run);
    if (object === null) {
      await insertWorkflowRun(tx, {
        organizationId: org,
        templateId: rule.id,
        status: 'failed',
        detail: {
          templateId: rule.id,
          triggerKind: rule.triggerKind,
          actionKind: rule.actionKind,
          heldRunId: run.runId,
          outcome: 'not_run',
          reason: 'trigger_object_gone',
        },
      });
    } else {
      await notifyAndRecord({ id: run.eventId, organizationId: org }, tx, rule, object, {
        heldRunId: run.runId,
      });
    }
    delivered += 1;
  }
  return delivered;
}
