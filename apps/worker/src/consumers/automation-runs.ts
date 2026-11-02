import { conditionsMatch } from '@tmanage/domain';
import type { ConditionEvent } from '@tmanage/domain';
import type { WorkerTransaction } from '../common/database/worker-database.js';
import {
  findWorkItemState,
  listRuleConditions,
} from '../common/database/automation-conditions-store.js';
import { insertNotification } from '../common/database/notifications-store.js';
import { findOrganizationTimeZone } from '../common/database/organization-clock-store.js';
import { readOrganizationCalendar } from '../common/database/working-calendar-store.js';
import { isHeldByCalendar } from '../jobs/due-soon-sweeper.js';
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

/**
 * A14 — "Skip weekends". The studio week ends on Friday and Saturday, so a rule with
 * `skipWeekends` does not send a reminder on those days **in the company's timezone**
 * (`organizations.timezone`; an unknown zone reads as UTC): the run is recorded as not run, held
 * for the weekend, with what it was about. Gap 10: the due-soon sweep then delivers every held run
 * on Sunday morning ({@link isWeekendHoldReleased}), once (`weekend-hold-store.ts`).
 * Pure, so the suite can enumerate the days.
 */
export function isHeldForWeekend(skipWeekends: boolean, at: Date, timeZone = 'UTC'): boolean {
  if (!skipWeekends) return false;
  const { day } = localClock(at, timeZone);
  return day === 5 || day === 6;
}

/** The local hour on Sunday from which held weekend runs go out. */
export const SUNDAY_DELIVERY_HOUR = 8;

const WEEKDAYS: Readonly<Record<string, number>> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

/** The weekday (0 = Sunday) and hour (0–23) at `at` in `timeZone`; an unknown zone reads as UTC. */
export function localClock(at: Date, timeZone: string): { day: number; hour: number } {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      weekday: 'short',
      hour: 'numeric',
      hourCycle: 'h23',
    }).formatToParts(at);
  } catch {
    return { day: at.getUTCDay(), hour: at.getUTCHours() };
  }
  const weekday = parts.find((part) => part.type === 'weekday')?.value ?? '';
  const hour = Number(parts.find((part) => part.type === 'hour')?.value);
  return {
    day: WEEKDAYS[weekday] ?? at.getUTCDay(),
    hour: Number.isInteger(hour) ? hour % 24 : at.getUTCHours(),
  };
}

/**
 * Gap 10 — whether a run held over the weekend may go out now: not on Friday or Saturday, and on
 * Sunday only from {@link SUNDAY_DELIVERY_HOUR} local time. A sweep that misses Sunday delivers on
 * the next weekday it runs (the store bounds how old a hold it still delivers).
 */
export function isWeekendHoldReleased(at: Date, timeZone: string): boolean {
  const { day, hour } = localClock(at, timeZone);
  if (day === 5 || day === 6) return false;
  return day !== 0 || hour >= SUNDAY_DELIVERY_HOUR;
}

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
    // What the Sunday delivery needs to send it later. The keys are hidden on the run page.
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
 * notice keeps the original dedupe key, and the run names the held run it closes.
 */
export async function notifyAndRecord(
  event: Pick<ClaimedOutboxEvent, 'id' | 'organizationId'>,
  tx: WorkerTransaction,
  rule: AutomationRule,
  object: TriggerObject,
  held?: { readonly heldRunId: string },
): Promise<void> {
  const base = {
    templateId: rule.id,
    triggerKind: rule.triggerKind,
    actionKind: rule.actionKind,
    ...(held === undefined ? {} : { heldRunId: held.heldRunId }),
  };

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
  // A held run whose every notice already existed was delivered by a racing sweep, which also
  // appended the run that closes it: record nothing twice.
  if (held !== undefined && told > 0 && fresh === 0) return;

  const after = held === undefined ? '' : ' on Sunday morning, after the weekend';
  await insertWorkflowRun(tx, {
    organizationId: event.organizationId,
    templateId: rule.id,
    status: told > 0 ? 'succeeded' : 'failed',
    detail:
      told > 0
        ? {
            ...base,
            outcome: 'executed',
            effect:
              told === 1
                ? `Notified the owner in their inbox${after}.`
                : `Notified ${String(told)} owners in their inbox${after}.`,
          }
        : { ...base, outcome: 'not_run', reason: 'no_owner_to_notify' },
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
    await runRule(event, tx, rule, object, now);
  }
};
