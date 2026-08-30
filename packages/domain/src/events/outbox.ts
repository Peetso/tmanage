/**
 * The outbox event vocabulary — PLAT-004, `24-EVENT-CATALOG` §§4–5.
 *
 * The catalog's §4 table names every MVP event; this file names the ones a producer
 * actually writes today, for the reason `AUDIT_ACTION_CATALOG` gives for its own shorter
 * list: a vocabulary member nothing emits is a member no consumer can ever receive, and a
 * reader could not tell "never happened" from "never built".
 *
 * ## The payloads are reference envelopes, never content copies
 *
 * §5's payload minimums and the schema comment on `outbox_events.payload_json` say the same
 * thing: identifiers and states, never bodies. `message.created.v1` carries the message's
 * *id* and nothing the author typed; a consumer that needs the text resolves current
 * permissions and reads it (§6 — "Consumers cannot infer authorization from event
 * receipt"). These types make that structural — there is no field a body could be put in.
 *
 * ## The aggregate type is part of the definition
 *
 * §4's table fixes each event's aggregate, and `ix_outbox_events_org_aggregate` is
 * `(organization_id, aggregate_type, aggregate_id)` — an aggregate type that varied by call
 * site would make that index useless for "every event about this row", exactly the failure
 * `auditObjectTypeFor` exists to prevent on the audit table. So writers never choose it;
 * {@link outboxAggregateTypeFor} derives it.
 *
 * ## Versioning
 *
 * The `.v1` suffix is the schema version in the name, per §3: additive optional fields stay
 * `v1`; anything that removes, renames or re-types a field is a new member of this union
 * alongside the old one, dual-published until every consumer has moved.
 */

import type { Audience } from '../policies/audience.js';

export interface OutboxEventDefinition {
  /** The aggregate the event describes — §4's "Aggregate" column, fixed per type. */
  readonly aggregateType: string;
  /** The catalog row that names it, quoted closely enough to be found by search. */
  readonly catalog: string;
}

export const OUTBOX_EVENT_CATALOG = {
  /** §4: "client request created" — the moment an obligation on the organization begins. */
  'client_request.submitted.v1': {
    aggregateType: 'client_request',
    catalog: '§4 client_request.submitted.v1 — manager inbox, notification, analytics',
  },
  /** §4: "valid state transition" — every legal move through `23-ERD` §6's machine. */
  'client_request.transitioned.v1': {
    aggregateType: 'client_request',
    catalog: '§4 client_request.transitioned.v1 — client/team notifications, search',
  },
  /** §4: "message committed". The aggregate is the conversation — ordering is per channel. */
  'message.created.v1': {
    aggregateType: 'conversation',
    catalog: '§4 message.created.v1 — realtime, mentions, search',
  },
  /** §4: "linked work created" — CHAT-003's conversion, exactly once per message. */
  'message.converted.v1': {
    aggregateType: 'message',
    catalog: '§4 message.converted.v1 — realtime, inbox, analytics',
  },
  /** §4: "fields/state changed". Emitted today for state transitions — see the producer. */
  'work_item.updated.v1': {
    aggregateType: 'work_item',
    catalog: '§4 work_item.updated.v1 — search, realtime, health',
  },
  /** §4: "blocker activated" — WORK-003, raised alongside the transition into `blocked`. */
  'work_item.blocked.v1': {
    aggregateType: 'work_item',
    catalog: '§4 work_item.blocked.v1 — health, inbox, notification',
  },
} as const satisfies Record<string, OutboxEventDefinition>;

export type OutboxEventType = keyof typeof OUTBOX_EVENT_CATALOG;

export const OUTBOX_EVENT_TYPES = Object.keys(OUTBOX_EVENT_CATALOG) as readonly OutboxEventType[];

export function isOutboxEventType(value: string): value is OutboxEventType {
  return Object.hasOwn(OUTBOX_EVENT_CATALOG, value);
}

/** The aggregate type an event describes. Writers never choose it. */
export function outboxAggregateTypeFor(type: OutboxEventType): string {
  return OUTBOX_EVENT_CATALOG[type].aggregateType;
}

// ─────────────────────────────────────────────────────────────────────────────
// Payloads — §5's minimums, as closed shapes
// ─────────────────────────────────────────────────────────────────────────────

/** §5 has no explicit row for a submission; ids and the initial state are its whole content. */
export interface ClientRequestSubmittedV1 {
  readonly requestId: string;
  readonly projectId: string;
  readonly clientOrganizationId: string;
  readonly state: string;
}

/**
 * §5: "request ID, project ID, from/to, version, optional accepted work ID; client-safe
 * reason reference — not internal notes." Field names match
 * `contracts/events/client-request-transitioned.v1.schema.json`, which is the registered
 * schema for this type. The reason itself — prose a manager wrote — never travels here; a
 * consumer that may show it reads the row.
 */
export interface ClientRequestTransitionedV1 {
  readonly requestId: string;
  readonly projectId: string;
  readonly clientOrganizationId: string;
  readonly fromStatus: string;
  readonly toStatus: string;
  readonly requestVersion: number;
  readonly acceptedWorkItemId: string | null;
}

/** No body, no author-typed text of any kind — §1's forbidden list, made structural. */
export interface MessageCreatedV1 {
  readonly messageId: string;
  readonly conversationId: string;
  readonly projectId: string;
  readonly parentMessageId: string | null;
}

/**
 * §5: "source message ID, work item ID, project ID, resulting audience; no message body."
 * Field names match `contracts/events/message-converted.v1.schema.json`.
 */
export interface MessageConvertedV1 {
  readonly messageId: string;
  readonly conversationId: string;
  readonly projectId: string;
  readonly workItemId: string;
  readonly audience: Audience;
}

/** Ids and the two states. Titles, blocker reasons and every other fact stay on the row. */
export interface WorkItemUpdatedV1 {
  readonly workItemId: string;
  readonly projectId: string;
  readonly fromState: string;
  readonly toState: string;
  readonly workItemVersion: number;
}

/**
 * Ids only — the blocker's reason and ask are prose a person wrote and stay on the row.
 * `ownerUserId` is who the ask is on, when it names anybody in this system: it is the
 * identifier the notification consumer needs, and nothing about *why* travels with it.
 */
export interface WorkItemBlockedV1 {
  readonly workItemId: string;
  readonly projectId: string;
  readonly blockerId: string;
  readonly ownerUserId: string | null;
}

/** Type-indexed payload map, so a producer cannot pair a type with another type's payload. */
export interface OutboxEventPayloads {
  readonly 'client_request.submitted.v1': ClientRequestSubmittedV1;
  readonly 'client_request.transitioned.v1': ClientRequestTransitionedV1;
  readonly 'message.created.v1': MessageCreatedV1;
  readonly 'message.converted.v1': MessageConvertedV1;
  readonly 'work_item.updated.v1': WorkItemUpdatedV1;
  readonly 'work_item.blocked.v1': WorkItemBlockedV1;
}
