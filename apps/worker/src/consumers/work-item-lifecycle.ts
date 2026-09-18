import { clientRequestStateMachine } from '@tmanage/domain';
import type { ClientRequestState } from '@tmanage/domain';
import type { WorkerTransaction } from '../common/database/worker-database.js';
import {
  findRequestsLinkedToWorkItem,
  insertSystemAuditEvent,
  insertWorkerOutboxEvent,
  transitionLinkedRequest,
} from '../common/database/lifecycle-store.js';
import type { ClaimedOutboxEvent } from '../common/database/outbox-store.js';
import type { OutboxHandler } from '../outbox/dispatcher.js';

/**
 * The lifecycle rule connecting two aggregates — the consumer PLAT-004 exists to run.
 *
 * When committed work starts, the client's accepted request becomes `planned`; when the
 * work is done, the planned request becomes `delivered`. `23-ERD` §6 has both transitions;
 * REQ-002 created the link (`client_requests.linked_work_item_id`); until this consumer,
 * nothing moved the request when the work moved, so a client watched their request sit at
 * "accepted" while the work sailed past "done".
 *
 * ## Exactly two rules, and nothing on any other state
 *
 * `in_progress` advances `accepted -> planned`; `done` advances `planned -> delivered`.
 * A request in any other state is left alone: a declined request does not resurrect
 * because someone reused its work item, and a request already at the target is the
 * at-least-once replay case — already-there **is** success, so the redelivered event
 * publishes without a second transition, audit row, or outbox event. The legality of each
 * move is still asked of `clientRequestStateMachine` rather than assumed, so if §6 ever
 * loses an arrow this consumer starts failing loudly instead of writing illegal states.
 *
 * ## What one applied rule writes
 *
 * The state change, the audit row (`actor_user_id` NULL — system-initiated, the case the
 * column is nullable for), and the `client_request.transitioned.v1` outbox event, all in
 * the claiming transaction's savepoint. The correlation id is carried forward from the
 * triggering event, so the whole causal chain — a person moved the work, the rule moved
 * the request — answers to one id.
 */

/** The request transition a work-item state triggers. Exported pure, for the unit suite. */
export function requestTransitionFor(
  workItemState: string,
): { readonly from: ClientRequestState; readonly to: ClientRequestState } | null {
  if (workItemState === 'in_progress') return { from: 'accepted', to: 'planned' };
  if (workItemState === 'done') return { from: 'planned', to: 'delivered' };
  return null;
}

interface WorkItemUpdatedPayload {
  readonly workItemId: string;
  readonly toState: string;
}

/**
 * Refuse a payload that does not carry the two facts the rule reads. A malformed event
 * retries, backs off and parks — the poison path, which is where an event that cannot be
 * understood belongs, rather than being published as if it had been handled.
 */
function parsePayload(event: ClaimedOutboxEvent): WorkItemUpdatedPayload {
  const payload = event.payload;
  if (payload !== null && typeof payload === 'object') {
    const candidate = payload as Record<string, unknown>;
    if (typeof candidate['workItemId'] === 'string' && typeof candidate['toState'] === 'string') {
      return { workItemId: candidate['workItemId'], toState: candidate['toState'] };
    }
  }
  throw new Error(`work_item.updated.v1 event ${event.id} has no readable workItemId/toState`);
}

export const workItemLifecycleConsumer: OutboxHandler = async (
  event: ClaimedOutboxEvent,
  tx: WorkerTransaction,
): Promise<void> => {
  const payload = parsePayload(event);

  const rule = requestTransitionFor(payload.toState);
  if (!rule) return; // Not a state this rule reads. Delivered, nothing to do.

  const linked = await findRequestsLinkedToWorkItem(tx, event.organizationId, payload.workItemId);
  if (linked.length === 0) return; // Work not born from a request. The ordinary case.

  // One work item can answer more than one request (R09): acceptance links existing work and
  // the schema does not forbid a second link. Every request currently in the rule's `from`
  // state must follow. A request already at `rule.to` is the replay case — already-there is
  // success, so it is skipped, not re-transitioned; a request in any other state (withdrawn,
  // declined, still in triage) is not ours to move. Filtering keeps both no-ops as before.
  const eligible = linked.filter((request) => request.state === rule.from);
  if (eligible.length === 0) return; // Replay, the API got there first, or none of ours.

  // The machine's blessing, not this file's opinion. `accepted -> planned` and
  // `planned -> delivered` require no facts today; if §6 changes, this throws and parks
  // rather than writing a state the diagram no longer has. Checked once — the move is the
  // same for every eligible request.
  const verdict = clientRequestStateMachine.transition(rule.from as ClientRequestState, rule.to);
  if (!verdict.ok) {
    throw new Error(`lifecycle rule refused by the state machine: ${verdict.detail}`);
  }

  const correlationId = event.correlationId ?? event.id;

  for (const request of eligible) {
    const version = await transitionLinkedRequest(
      tx,
      event.organizationId,
      request.id,
      rule.from,
      rule.to,
    );
    if (version === null) {
      // Unreachable inside the FOR UPDATE lock; throwing (and retrying) beats guessing.
      throw new Error(`client request ${request.id} changed under the lifecycle rule`);
    }

    await insertSystemAuditEvent(tx, {
      organizationId: event.organizationId,
      action: 'client_request.transitioned',
      objectId: request.id,
      correlationId,
      metadata: {
        project_id: request.projectId,
        client_organization_id: request.clientOrganizationId,
        state_before: rule.from,
        state_after: rule.to,
        // What moved it — the linked work item, not a person. `converted_from_id`'s
        // precedent: an identifier plus a classification, no forbidden key segment.
        linked_work_item_id: payload.workItemId,
        caused_by: 'work_item_lifecycle',
      },
    });

    await insertWorkerOutboxEvent(tx, {
      organizationId: event.organizationId,
      type: 'client_request.transitioned.v1',
      aggregateId: request.id,
      correlationId,
      payload: {
        requestId: request.id,
        projectId: request.projectId,
        clientOrganizationId: request.clientOrganizationId,
        fromStatus: rule.from,
        toStatus: rule.to,
        requestVersion: version,
        acceptedWorkItemId: payload.workItemId,
      },
    });
  }
};
