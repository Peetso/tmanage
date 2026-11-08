import type { ClaimedOutboxEvent } from '../common/database/outbox-store.js';
import {
  MY_WORK_TOPIC,
  projectTopic,
  userTopic,
  workItemPeople,
} from '../common/database/work-topic-store.js';
import type { OutboxHandler } from '../outbox/dispatcher.js';
import type { RealtimeHub } from './hub.js';

/**
 * 53-01 — work events become hub frames, so boards, lists, My Day and iterations refresh live.
 *
 * The coverage this closes (web listens vs worker emits, before this file):
 *
 * | event                              | emitted by the API        | framed to the web |
 * | ---------------------------------- | ------------------------- | ----------------- |
 * | `message.created.v1`               | channel message           | yes (channel)     |
 * | `direct_message.created.v1`        | direct message            | yes (DM)          |
 * | `work_item.created.v1`             | create                    | now (project, me) |
 * | `work_item.updated.v1`             | state move (board column) | now (project, me) |
 * | `work_item.changed.v1`             | field edit / project move | now (project, me) |
 * | `work_item.commented.v1`           | every comment             | now (project, me) |
 * | `work_item.comment_created.v1`     | comment with @mentions    | now (project, me) |
 * | `work_item.people_assigned.v1`     | doer / supervisor added   | now (project, me) |
 *
 * Each event is published on `project:<projectId>` (and on the previous project when an item
 * moved between projects) and on `user:<id>` for its owner, doers and supervisors plus anyone the
 * payload names as newly assigned. Frames are ids only — event type, work item id, project id —
 * and the personal frame names the topic `me`, which is how the subscriber asked for it. Delivery
 * to nobody is success; at-least-once is absorbed by the client's debounced refetch.
 */

export const WORK_FRAME_EVENT_TYPES: readonly string[] = [
  'work_item.created.v1',
  'work_item.updated.v1',
  'work_item.changed.v1',
  'work_item.commented.v1',
  'work_item.comment_created.v1',
  'work_item.people_assigned.v1',
];

function text(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === 'string' && value !== '' ? value : null;
}

/** The project topics one event goes to: its project, and the one it left (if it moved). */
export function workFrameProjects(payload: Record<string, unknown>): string[] {
  const projects = [text(payload, 'projectId'), text(payload, 'previousProjectId')].filter(
    (id): id is string => id !== null,
  );
  return [...new Set(projects)];
}

export function createWorkFanOut(hub: RealtimeHub): OutboxHandler {
  return async (event: ClaimedOutboxEvent, tx): Promise<void> => {
    const payload = event.payload;
    // Best-effort by design (the frame is a nudge; the durable truth already committed): an
    // unreadable payload or a failed lookup skips the frame rather than failing the event and
    // rolling back the handler composed before this one.
    if (payload === null || typeof payload !== 'object') return;
    const record = payload as Record<string, unknown>;
    const workItemId = text(record, 'workItemId');
    if (workItemId === null) return;
    const projects = workFrameProjects(record);
    const projectId = projects[0] ?? null;

    const frame = (topic: string) => ({
      type: 'event' as const,
      eventType: event.type,
      conversationId: topic,
      objectId: workItemId,
      sequence: null,
      patch: { projectId },
    });
    for (const id of projects)
      hub.publish(event.organizationId, projectTopic(id), frame(projectTopic(id)));

    const named = Array.isArray(record['userIds'])
      ? (record['userIds'] as unknown[]).filter((id): id is string => typeof id === 'string')
      : [];
    let related: readonly string[] = [];
    try {
      related = await workItemPeople(tx, event.organizationId, workItemId);
    } catch {
      // The project frame already went out; My Day falls back to its own refetch.
    }
    const people = new Set([...related, ...named]);
    for (const userId of people) {
      hub.publish(event.organizationId, userTopic(userId), frame(MY_WORK_TOPIC));
    }
  };
}

/** Compose the work fan-out after whatever handler already answers each work event type. */
export function withWorkFanOut(
  handlers: Readonly<Record<string, OutboxHandler>>,
  fanOut: OutboxHandler,
  both: (first: OutboxHandler, second: OutboxHandler) => OutboxHandler,
): Record<string, OutboxHandler> {
  const next: Record<string, OutboxHandler> = { ...handlers };
  for (const type of WORK_FRAME_EVENT_TYPES) {
    const existing = handlers[type];
    next[type] = existing === undefined ? fanOut : both(existing, fanOut);
  }
  return next;
}
