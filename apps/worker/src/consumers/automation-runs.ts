import { conditionsMatch, flowIssues, planAutomationFlow } from '@tmanage/domain';
import type { ConditionEvent } from '@tmanage/domain';
import { findRuleFlow } from '../common/database/automation-flow-store.js';
import type { RuleFlow } from '../common/database/automation-flow-store.js';
import type { WorkerTransaction } from '../common/database/worker-database.js';
import {
  findWorkItemState,
  listRuleConditions,
} from '../common/database/automation-conditions-store.js';
import { insertNotification } from '../common/database/notifications-store.js';
import { findOrganizationTimeZone } from '../common/database/organization-clock-store.js';
import { readOrganizationCalendar } from '../common/database/working-calendar-store.js';
import { isHeldByCalendar } from '../jobs/weekend-hold-calendar.js';
import {
  findDocumentFacts,
  findInternalReach,
  findProjectOwnerId,
  findWorkItemFacts,
  insertWorkflowRun,
  listEnabledRulesForTrigger,
  listProjectManagerIds,
} from '../common/database/collaboration-store.js';
import type { AutomationRule } from '../common/database/collaboration-store.js';
import type { ClaimedOutboxEvent } from '../common/database/outbox-store.js';
import type { OutboxHandler } from '../outbox/dispatcher.js';
import { mayBeTold } from './collaboration-notices.js';

/**
 * CQ-12 (AUT-01) — rules fire. Before this, an enabled automation ("Request submitted → Notify
 * owner") was a row nothing read: no consumer listened for its trigger, so it never ran and its
 * history stayed empty.
 *
 * Each trigger kind the rule builder offers is mapped to the event that says it happened. When
 * one is delivered, every **enabled** rule in that organization with that trigger runs inside the
 * event's transaction, and each run appends a `workflow_runs` row — the history "Run history"
 * reads — with the same outcome vocabulary a manual run records.
 *
 * ## What a run does
 *
 * `notify_owner` is the one action with an executor: it writes an inbox notification, about the
 * triggering object, to its owner — the work item's owner, the document's author, or (for a
 * request or a meeting, which belong to the project) the project's managers and owner of record,
 * falling back to them for a work item with no owner. Each recipient's access is re-checked from
 * the current rows (§6), so a rule never tells somebody about an object they cannot open, and the
 * dedupe key (`automation:<rule>:<event>`) makes a redelivery a no-op.
 *
 * `create_work_item` and `post_message` have no executor yet and record a **not run** with the
 * reason, as do the external kinds — a run never claims an effect it did not have (AUT-02).
 *
 * ## Conditions (C1)
 *
 * A rule fires only when its saved "Only if" conditions hold for the triggering object
 * (`conditionsMatch` from `@tmanage/domain`, the same reading the API uses); a rule whose
 * conditions do not hold is skipped without a run row.
 *
 * ## Branching rules (58-C1)
 *
 * A rule saved in the builder has a graph (`workflow_flow_versions`): each If takes its Yes or No
 * branch for the triggering object (the same fields the conditions read), and each Then on the path
 * runs with the same executor rules as a linear rule. The run row logs every step and names the
 * graph version it took. An unfinished graph is not run. A rule with no graph runs as before.
 */

/** The automation trigger each event type answers to. */
export const TRIGGER_FOR_EVENT: Readonly<Record<string, string>> = {
  'client_request.submitted.v1': 'request_submitted',
  'work_item.created.v1': 'work_item_created',
  'work_item.updated.v1': 'work_item_transitioned',
  'meeting.scheduled.v1': 'meeting_scheduled',
  'document.published.v1': 'document_published',
};

export const AUTOMATION_NOTICE_TYPE = 'automation.notified.v1';

/** The object a run is about, and who owns it. */
export interface TriggerObject {
  readonly objectType: string;
  readonly objectId: string;
  readonly projectId: string;
  readonly ownerIds: readonly string[];
}

function field(event: ClaimedOutboxEvent, key: string): string {
  const payload = event.payload;
  if (payload !== null && typeof payload === 'object') {
    const value = (payload as Record<string, unknown>)[key];
    if (typeof value === 'string') return value;
  }
  throw new Error(`event ${event.id} has no readable ${key}`);
}

export async function projectOwners(
  tx: WorkerTransaction,
  organizationId: string,
  projectId: string,
): Promise<readonly string[]> {
  const ids = [...(await listProjectManagerIds(tx, organizationId, projectId))];
  const owner = await findProjectOwnerId(tx, organizationId, projectId);
  if (owner !== null && !ids.includes(owner)) ids.push(owner);
  return ids;
}

async function triggerObject(
  event: ClaimedOutboxEvent,
  tx: WorkerTransaction,
): Promise<TriggerObject | null> {
  const org = event.organizationId;
  switch (event.type) {
    case 'client_request.submitted.v1': {
      const projectId = field(event, 'projectId');
      return {
        objectType: 'client_request',
        objectId: field(event, 'requestId'),
        projectId,
        ownerIds: await projectOwners(tx, org, projectId),
      };
    }
    case 'work_item.created.v1':
    case 'work_item.updated.v1': {
      const workItemId = field(event, 'workItemId');
      const item = await findWorkItemFacts(tx, org, workItemId);
      if (item === null) return null;
      return {
        objectType: 'work_item',
        objectId: workItemId,
        projectId: item.projectId,
        ownerIds:
          item.ownerUserId !== null
            ? [item.ownerUserId]
            : await projectOwners(tx, org, item.projectId),
      };
    }
    case 'meeting.scheduled.v1': {
      const projectId = field(event, 'projectId');
      return {
        objectType: 'meeting',
        objectId: field(event, 'meetingId'),
        projectId,
        ownerIds: await projectOwners(tx, org, projectId),
      };
    }
    case 'document.published.v1': {
      const documentId = field(event, 'documentId');
      const document = await findDocumentFacts(tx, org, documentId);
      if (document === null) return null;
      return {
        objectType: 'document',
        objectId: documentId,
        projectId: document.projectId,
        ownerIds: [document.createdByUserId],
      };
    }
    default:
      return null;
  }
}

/** The run outcome for a rule whose action cannot run — pure, so the suite can enumerate it. */
export function notRunReason(actionKind: string): string | null {
  if (actionKind === 'notify_owner') return null;
  if (actionKind === 'create_work_item' || actionKind === 'post_message') {
    return 'action_not_available_yet';
  }
  return 'external_action_not_supported_in_app';
}

// A14 / Gap 10 / R14 hold rules live in `jobs/weekend-hold-calendar.ts` (R15: breaks the
// automation-runs <-> due-soon-sweeper import cycle); re-exported for existing callers.
export {
  SUNDAY_DELIVERY_HOUR,
  isHeldForWeekend,
  isWeekendHoldReleased,
  localClock,
} from '../jobs/weekend-hold-calendar.js';

/**
 * R14 (53-02 follow-up) — the hold reads the company's working calendar (a non-working day or a
 * holiday, in the calendar's zone); a company that never saved one keeps the Friday–Saturday rule
 * in `organizations.timezone`.
 */
async function isHeldNow(
  tx: WorkerTransaction,
  organizationId: string,
  now: Date,
): Promise<boolean> {
  const timeZone = await findOrganizationTimeZone(tx, organizationId);
  return isHeldByCalendar(await readOrganizationCalendar(tx, organizationId), now, timeZone);
}

/**
 * Run one rule for one triggering object and append its run. `event` is what makes the run
 * replay-proof: its id is the notification dedupe key (an outbox event, or a due-soon claim).
 */
export async function runRule(
  event: Pick<ClaimedOutboxEvent, 'id' | 'organizationId'>,
  tx: WorkerTransaction,
  rule: AutomationRule,
  object: TriggerObject | null,
  now: Date,
): Promise<void> {
  const base = {
    templateId: rule.id,
    triggerKind: rule.triggerKind,
    actionKind: rule.actionKind,
  };
  const reason = notRunReason(rule.actionKind);
  if (reason !== null || object === null) {
    await insertWorkflowRun(tx, {
      organizationId: event.organizationId,
      templateId: rule.id,
      status: 'failed',
      detail: { ...base, outcome: 'not_run', reason: reason ?? 'trigger_object_gone' },
    });
    return;
  }
  if (rule.skipWeekends && (await isHeldNow(tx, event.organizationId, now))) {
    // What the later release (weekend-hold-store.ts) needs to send it. The keys are hidden on the run page.
    await insertWorkflowRun(tx, {
      organizationId: event.organizationId,
      templateId: rule.id,
      status: 'failed',
      detail: {
        ...base,
        outcome: 'not_run',
        reason: 'held_for_weekend',
        heldEventId: event.id,
        heldObjectType: object.objectType,
        heldObjectId: object.objectId,
        heldProjectId: object.projectId,
      },
    });
    return;
  }
  await notifyAndRecord(event, tx, rule, object);
}

/**
 * The notify-owner action: tell each owner (and the project lead when the rule says so) who may
 * still open the object, then append the run. `held` marks a weekend-held run delivered later: the
 * notice keeps the original dedupe key, the run names the held run it closes, and its effect names
 * the day it went out.
 */
export async function notifyAndRecord(
  event: Pick<ClaimedOutboxEvent, 'id' | 'organizationId'>,
  tx: WorkerTransaction,
  rule: AutomationRule,
  object: TriggerObject,
  held?: {
    readonly heldRunId: string;
    /** R15: the release-day words (`heldReleaseNote`), e.g. " on Monday, the next working day". */
    readonly releaseNote: string;
  },
): Promise<void> {
  const base = {
    templateId: rule.id,
    triggerKind: rule.triggerKind,
    actionKind: rule.actionKind,
    ...(held === undefined ? {} : { heldRunId: held.heldRunId }),
  };

  const { told, fresh } = await tellOwners(event, tx, rule, object);
  // A held run whose every notice already existed was delivered by a racing sweep, which also
  // appended the run that closes it: record nothing twice.
  if (held !== undefined && told > 0 && fresh === 0) return;

  const after = held === undefined ? '' : held.releaseNote;
  await insertWorkflowRun(tx, {
    organizationId: event.organizationId,
    templateId: rule.id,
    status: told > 0 ? 'succeeded' : 'failed',
    detail:
      told > 0
        ? { ...base, outcome: 'executed', effect: toldEffect(told, after) }
        : { ...base, outcome: 'not_run', reason: 'no_owner_to_notify' },
  });
}

function toldEffect(told: number, after: string): string {
  return told === 1
    ? `Notified the owner in their inbox${after}.`
    : `Notified ${String(told)} owners in their inbox${after}.`;
}

/**
 * Tell each owner (and the project lead when the rule says so) who may still open the object.
 * `told` counts who was reached, `fresh` the notices not already there (a redelivery adds none).
 */
async function tellOwners(
  event: Pick<ClaimedOutboxEvent, 'id' | 'organizationId'>,
  tx: WorkerTransaction,
  rule: AutomationRule,
  object: TriggerObject,
): Promise<{ readonly told: number; readonly fresh: number }> {
  // A14 "Also tell: Project lead" — the project's managers and owner of record hear it too.
  const recipients = [...object.ownerIds];
  if (rule.alsoTell === 'project_lead') {
    for (const id of await projectOwners(tx, event.organizationId, object.projectId)) {
      if (!recipients.includes(id)) recipients.push(id);
    }
  }

  let told = 0;
  let fresh = 0;
  for (const userId of recipients) {
    const reach = await findInternalReach(tx, event.organizationId, userId, object.projectId);
    if (!mayBeTold(reach, 'work.read')) continue;
    const inserted = await insertNotification(tx, {
      organizationId: event.organizationId,
      recipientUserId: userId,
      type: AUTOMATION_NOTICE_TYPE,
      objectType: object.objectType,
      objectId: object.objectId,
      dedupeKey: `automation:${rule.id}:${event.id}`,
    });
    told += 1;
    if (inserted) fresh += 1;
  }
  return { told, fresh };
}

/**
 * 58-C1 — run a branching rule for one triggering object: walk its graph, run each Then on the
 * path (only `notify_owner` has an executor; any other kind is logged not run), and append one run
 * row with the per-step log. The weekend hold is a linear-rule option and does not apply here.
 */
export async function runFlowRule(
  event: Pick<ClaimedOutboxEvent, 'id' | 'organizationId'>,
  tx: WorkerTransaction,
  rule: AutomationRule,
  saved: RuleFlow,
  object: TriggerObject | null,
  conditionEvent: ConditionEvent,
): Promise<void> {
  const base = { templateId: rule.id, triggerKind: rule.triggerKind, flowVersion: saved.version };
  const record = (status: 'succeeded' | 'failed', detail: Record<string, unknown>) =>
    insertWorkflowRun(tx, {
      organizationId: event.organizationId,
      templateId: rule.id,
      status,
      detail: { ...base, ...detail },
    });
  if (saved.flow === null || flowIssues(saved.flow).length > 0) {
    await record('failed', { outcome: 'not_run', reason: 'flow_incomplete', steps: [] });
    return;
  }
  if (object === null) {
    await record('failed', { outcome: 'not_run', reason: 'trigger_object_gone', steps: [] });
    return;
  }
  const steps: Record<string, unknown>[] = [];
  let actions = 0;
  let ran = 0;
  for (const step of planAutomationFlow(saved.flow, conditionEvent)) {
    if (step.type === 'condition') {
      steps.push(step);
      continue;
    }
    actions += 1;
    const reason = notRunReason(step.actionKind);
    if (reason !== null) {
      steps.push({ ...step, outcome: 'not_run', reason });
      continue;
    }
    const { told } = await tellOwners(event, tx, rule, object);
    if (told > 0) ran += 1;
    steps.push(
      told > 0
        ? { ...step, outcome: 'executed', effect: toldEffect(told, '') }
        : { ...step, outcome: 'not_run', reason: 'no_owner_to_notify' },
    );
  }
  await record(actions > 0 && ran === actions ? 'succeeded' : 'failed', {
    outcome: ran > 0 ? 'executed' : 'not_run',
    ...(ran > 0 ? {} : { reason: actions === 0 ? 'no_step_on_path' : 'action_not_available_yet' }),
    steps,
  });
}

/**
 * C1 — the fields a rule's "Only if" conditions read: the object's project, and for a work item its
 * current state as `status` (what the rule page's status chip compares against `done`).
 */
export async function conditionEventFor(
  tx: WorkerTransaction,
  organizationId: string,
  object: TriggerObject,
): Promise<ConditionEvent> {
  const event: Record<string, unknown> = {
    object_type: object.objectType,
    project_id: object.projectId,
  };
  if (object.objectType === 'work_item') {
    const state = await findWorkItemState(tx, organizationId, object.objectId);
    if (state !== null) event['status'] = state;
  }
  return event;
}

/**
 * C1 — whether a rule's saved conditions let it fire for this object. A rule with no conditions
 * always fires; otherwise the newest condition per field must hold (`conditionsMatch`). A rule
 * that does not match is simply not run — no run row, as if its trigger had not happened.
 */
export async function ruleConditionsHold(
  tx: WorkerTransaction,
  organizationId: string,
  rule: AutomationRule,
  conditionEvent: ConditionEvent,
): Promise<boolean> {
  const conditions = await listRuleConditions(tx, organizationId, rule.id);
  return conditionsMatch(conditions, conditionEvent);
}

/** The runner for one event: every enabled rule with the event's trigger, in id order. */
export const automationRunsConsumer: OutboxHandler = async (event, tx) => {
  const trigger = TRIGGER_FOR_EVENT[event.type];
  if (trigger === undefined) return;
  const rules = await listEnabledRulesForTrigger(tx, event.organizationId, trigger);
  if (rules.length === 0) return; // The common case: no rule, no reads.
  const object = await triggerObject(event, tx);
  const conditionEvent =
    object === null ? null : await conditionEventFor(tx, event.organizationId, object);
  const now = new Date();
  for (const rule of rules) {
    if (
      conditionEvent !== null &&
      !(await ruleConditionsHold(tx, event.organizationId, rule, conditionEvent))
    ) {
      continue;
    }
    const saved = await findRuleFlow(tx, event.organizationId, rule.id);
    if (saved === null) await runRule(event, tx, rule, object, now);
    else await runFlowRule(event, tx, rule, saved, object, conditionEvent ?? {});
  }
};
