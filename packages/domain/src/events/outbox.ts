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
  /** Audit gap 4: a message posted on a client request's client <-> studio thread (0212). */
  'client_request.message_posted.v1': {
    aggregateType: 'client_request',
    catalog: '§4 client request message — client/team notifications',
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
  /**
   * FILE-001. §4 names the aggregate `upload` and the DBML names `storage_reservation`;
   * the row that exists is `upload_sessions`, and `ix_outbox_events_org_aggregate`
   * indexes real row kinds, so all four events describe that aggregate. Recorded as a
   * divergence in docs/implementation-status.md.
   */
  'upload.completed.v1': {
    aggregateType: 'upload_session',
    catalog: '§4 upload.completed.v1 — verification/scan worker; security log',
  },
  'usage.storage_reserved.v1': {
    aggregateType: 'upload_session',
    catalog: '§4 usage.storage_reserved.v1 — usage UI, cost telemetry',
  },
  'usage.storage_committed.v1': {
    aggregateType: 'upload_session',
    catalog: '§4 usage.storage_committed.v1 — usage UI, reconciliation, threshold evaluator',
  },
  'usage.storage_released.v1': {
    aggregateType: 'upload_session',
    catalog: '§4 usage.storage_released.v1 — usage UI, reconciliation',
  },
  /**
   * USAGE-001 slice 4. §4 grades this "audit yes at 100%" and names the aggregate
   * `organization_usage`; the row that exists is `usage_counters` (one per organization for
   * the storage metric), and `ix_outbox_events_org_aggregate` indexes real row kinds, so the
   * aggregate is `usage_counter` and the aggregate id is that counter row — the same
   * divergence, for the same reason, as the four FILE-001 upload events above. Produced by
   * service code (the reserve and commit paths and the reconciler), never by a route, when a
   * band boundary (70/85/95/100 of used + reserved over quota) is crossed rising, with
   * hysteresis. Recorded as a divergence in docs/implementation-status.md.
   */
  'usage.threshold_reached.v1': {
    aggregateType: 'usage_counter',
    catalog: '§4 usage.threshold_reached.v1 — authorized owner/admin notification, billing UI',
  },
  /**
   * FILE-002. §4: "validation/scan failed", audit yes. The aggregate is the asset — the
   * row the verification judged and the row a consumer would read to learn why — not the
   * session that produced it; `ix_outbox_events_org_aggregate` answers "everything about
   * this file" only if the file's events name the file.
   */
  'file.rejected.v1': {
    aggregateType: 'file_asset',
    catalog: '§4 file.rejected.v1 — inbox/notification, security log',
  },
  /**
   * FILE-002 slice B. §4: "validation/scan passed", sensitivity "security metadata". The
   * aggregate is the asset for `file.rejected.v1`'s reason. Raised only by the scan pass,
   * inside the transaction that moves `scanning → ready`, so a consumer never learns of a
   * file that is not servable.
   */
  'file.ready.v1': {
    aggregateType: 'file_asset',
    catalog: '§4 file.ready.v1 — preview, requester notification; security metadata',
  },
  /**
   * FILE-003. The retention-lifecycle job's event when it deletes a rejected/quarantined
   * object's provider bytes and gives the counted bytes back. The aggregate is the asset, for
   * `file.rejected.v1`'s reason — a consumer asking "everything about this file" is answered
   * only if the file's events name the file. It carries the byte delta the ledger row records,
   * so `usage.*` reconciliation stays whole: the ledger move this event sources keeps the
   * append-only sum equal to the decremented counter (`49-PRICING` §6 step 8). No `usage.*`
   * schema is claimed for it (that tree is another slice's); the divergence is recorded in
   * docs/implementation-status.md, as the other unschematised usage moves are.
   */
  'file.purged.v1': {
    aggregateType: 'file_asset',
    catalog: '§4 file lifecycle — FILE-003 retention deletion; usage reconciliation',
  },
  /** CQ-12 (AUT-01): "work item created" — the automation trigger `work_item_created`. */
  'work_item.created.v1': {
    aggregateType: 'work_item',
    catalog: '§4 work_item.created.v1 — automations, search',
  },
  /**
   * CQ-12 (APR-03): a work item was made "client action needed". The client people who can act
   * on it are emailed; the portal already lists it as waiting on them.
   */
  'work_item.client_action_requested.v1': {
    aggregateType: 'work_item',
    catalog: '§4 work_item audience → client_action_required — client email',
  },
  /** CQ-12 (COL-05): a comment was added to a document — author and mentioned people are told. */
  'document.comment_created.v1': {
    aggregateType: 'document',
    catalog: '§4 comment created — notification, mentions',
  },
  /** CQ-12 (AUT-01): a document was published to the client — the trigger `document_published`. */
  'document.published.v1': {
    aggregateType: 'document',
    catalog: '§4 document published — automations',
  },
  /** CQ-12 (AUT-01): a meeting was scheduled — the trigger `meeting_scheduled`. */
  'meeting.scheduled.v1': {
    aggregateType: 'meeting',
    catalog: '§4 meeting scheduled — automations',
  },
  /** CQ-12 (COL-05): somebody was invited to a meeting — the invitee is told. */
  'meeting.attendee_invited.v1': {
    aggregateType: 'meeting',
    catalog: '§4 meeting invite — notification, email',
  },
  /** CQ-12 (COL-05): somebody was put on a project — they are told. */
  'project.member_added.v1': {
    aggregateType: 'project',
    catalog: '§4 project membership granted — notification, email',
  },
  /**
   * 0211 (audit gap 1, APR-01/02): a deliverable version was sent to the client for approval. The
   * client people who may decide are emailed a link to the portal's Approve screen.
   */
  'approval.requested.v1': {
    aggregateType: 'approval',
    catalog: '§4 approval.requested — client email',
  },
  /**
   * Q3: a client (or staff reviewer) approved or requested changes. The internal side — the person
   * who sent it and the team who can create deliverables on the project — is told.
   */
  'approval.decided.v1': {
    aggregateType: 'approval',
    catalog: '§4 approval.decided — team notification, email',
  },
} as const satisfies Record<string, OutboxEventDefinition>;

export type OutboxEventType = keyof typeof OUTBOX_EVENT_CATALOG;

export const OUTBOX_EVENT_TYPES = Object.keys(OUTBOX_EVENT_CATALOG) as readonly OutboxEventType[];
  /**
   * BK3-left: a message was posted in a one-to-one direct conversation (0214). The aggregate is
   * the direct conversation, so ordering is per pair. Realtime fan-out and the recipient's notice.
   */
  'direct_message.created.v1': {
    aggregateType: 'direct_conversation',
    catalog: '§4 message.created.v1 (direct) — realtime, recipient notification',
  },

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

/**
 * Audit gap 4 (0212). Ids and flags only — never the body. `clientVisible` false is a team-only
 * note, which a consumer must not deliver to a client; `authorKind` says which side wrote it, so a
 * consumer notifies the other side.
 */
export interface ClientRequestMessagePostedV1 {
  readonly requestId: string;
  readonly messageId: string;
  readonly projectId: string;
  readonly clientOrganizationId: string;
  readonly authorMembershipId: string;
  readonly authorKind: 'internal' | 'client';
  readonly clientVisible: boolean;
}

/**
 * No body, no author-typed text of any kind — §1's forbidden list, made structural.
 *
 * `sequenceNo` joined on 2026-08-30 as an additive optional field (§3's compatible kind):
 * RT-001's broadcasts carry "object ID, sequence, minimal safe patch", and the sequence is
 * the channel's own — CHAT-001's allocator — so a client can detect a gap and refetch.
 */
export interface MessageCreatedV1 {
  readonly messageId: string;
  readonly conversationId: string;
  readonly projectId: string;
  readonly parentMessageId: string | null;
  readonly sequenceNo?: number;
  /**
   * CQ-12 (COL-05), additive optional: the user ids the body mentions with the `@<userId>` token
   * ({@link extractMentionedUserIds}). Ids are references, not content — the body stays on the row.
   */
  readonly mentionedUserIds?: readonly string[];
  /** CQ-12, additive optional: who wrote it — the "who mentioned you" of the notice. */
  readonly authorUserId?: string;
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

/**
 * §5 for storage usage: "reservation/file version ID, byte delta, metric key, reason ...;
 * never filename or content." There is no field a name or a MIME type could be put in.
 */
export interface UploadCompletedV1 {
  readonly uploadSessionId: string;
  readonly fileAssetId: string;
  readonly fileVersionId: string;
  readonly projectId: string;
  readonly purpose: string;
  /** The row `purpose` says the file belongs to — the request, for `request_attachment`. */
  readonly objectId: string | null;
  readonly sizeBytes: number;
}

export interface UsageStorageReservedV1 {
  readonly uploadSessionId: string;
  readonly metricKey: string;
  readonly deltaBytes: number;
}

export interface UsageStorageCommittedV1 {
  readonly uploadSessionId: string;
  readonly fileVersionId: string;
  readonly metricKey: string;
  /** The provider's count — what `used_value` grew by. */
  readonly deltaBytes: number;
  /** What the reservation held, which the commit released. */
  readonly reservedBytes: number;
}

export interface UsageStorageReleasedV1 {
  readonly uploadSessionId: string;
  readonly metricKey: string;
  readonly deltaBytes: number;
  readonly cause: 'cancelled' | 'expired' | 'failed';
}

/**
 * USAGE-001 slice 4. The band crossed and the numbers behind it — safe scalars only, no
 * filename and no content (§1's forbidden list has nothing this shape could carry). `band` is
 * one of 70/85/95/100. `idempotencyKey` is `<counterId>:<band>:<counterVersion>`: the counter
 * version advances on every move, so a re-entry after the usage fell back below the hysteresis
 * floor carries a fresh key and is delivered again, while a redelivery of the same crossing
 * does not — the property the notification consumer dedupes on.
 */
export interface UsageThresholdReachedV1 {
  readonly organizationId: string;
  readonly band: number;
  readonly used: number;
  readonly reserved: number;
  readonly quota: number;
  readonly idempotencyKey: string;
  readonly occurredAt: string;
}

/**
 * FILE-002. Ids, the purpose, and the rejection as a code — §7's "never raw content" and
 * §1's forbidden list: no filename, no declared or detected type, no digest. A consumer
 * that may tell the uploader why reads the row under its own permissions.
 */
export interface FileRejectedV1 {
  readonly fileAssetId: string;
  readonly fileVersionId: string;
  readonly projectId: string;
  readonly purpose: string;
  readonly objectId: string | null;
  readonly rejectionCode: string;
}

/**
 * FILE-002 slice B. Ids, the purpose and the size — §7's "never raw content": no
 * filename, no type, no digest, no scanner. A consumer that renders the file reads the row
 * under its own permissions; the correlation id on the outbox row is the audit row's.
 */
export interface FileReadyV1 {
  readonly fileAssetId: string;
  readonly fileVersionId: string;
  readonly projectId: string;
  readonly purpose: string;
  readonly objectId: string | null;
  readonly sizeBytes: number;
}

/**
 * FILE-003. Ids, the metric and the byte delta — §7's "never raw content": no filename, no
 * type, no digest, no rejection reason. `deltaBytes` is the magnitude the counter's `used`
 * dimension is decremented by and the ledger row records as negative, so a reconciliation
 * consumer can keep the counter and the append-only ledger in agreement.
 */
export interface FilePurgedV1 {
  readonly fileAssetId: string;
  readonly fileVersionId: string;
  readonly projectId: string;
  readonly metricKey: string;
  readonly deltaBytes: number;
}

/** CQ-12: ids and the creation state; the title stays on the row. */
export interface WorkItemCreatedV1 {
  readonly workItemId: string;
  readonly projectId: string;
  readonly state: string;
}

/** CQ-12 (APR-03): the item that now waits on the client. */
export interface WorkItemClientActionRequestedV1 {
  readonly workItemId: string;
  readonly projectId: string;
}

/** CQ-12 (COL-05): ids only — the comment text stays on the row. */
export interface DocumentCommentCreatedV1 {
  readonly documentId: string;
  readonly commentId: string;
  readonly projectId: string;
  readonly authorUserId: string;
  readonly mentionedUserIds: readonly string[];
}

/** CQ-12 (AUT-01). */
export interface DocumentPublishedV1 {
  readonly documentId: string;
  readonly projectId: string;
}

/** CQ-12 (AUT-01). */
export interface MeetingScheduledV1 {
  readonly meetingId: string;
  readonly projectId: string;
}

/** CQ-12 (COL-05). */
export interface MeetingAttendeeInvitedV1 {
  readonly meetingId: string;
  readonly projectId: string;
  readonly attendeeUserId: string;
  readonly invitedByUserId: string;
}

/** CQ-12 (COL-05). */
export interface ProjectMemberAddedV1 {
  readonly projectId: string;
  readonly userId: string;
  readonly addedByUserId: string;
}

/**
 * 0211: ids only. `reviewerUserIds` narrows who is told (the client contacts the sender picked);
 * the worker still re-checks each one's access to the project at delivery.
 */
export interface ApprovalRequestedV1 {
  readonly approvalId: string;
  readonly deliverableId: string;
  readonly deliverableVersionId: string;
  readonly projectId: string;
  readonly reviewerUserIds: readonly string[];
}

/**
 * Q3: ids and the outcome only, never the feedback text. `requestedByUserId` is the approval's
 * `requested_by` (the sender); the worker re-checks every recipient's access at delivery.
 */
export interface ApprovalDecidedV1 {
  readonly approvalId: string;
  readonly deliverableId: string;
  readonly deliverableVersionId: string;
  readonly projectId: string;
  readonly decision: 'approved' | 'changes_requested';
  readonly decidedByUserId: string;
  readonly requestedByUserId: string;
}

/** Type-indexed payload map, so a producer cannot pair a type with another type's payload. */
export interface OutboxEventPayloads {
  readonly 'client_request.submitted.v1': ClientRequestSubmittedV1;
  readonly 'client_request.transitioned.v1': ClientRequestTransitionedV1;
  readonly 'client_request.message_posted.v1': ClientRequestMessagePostedV1;
  readonly 'message.created.v1': MessageCreatedV1;
  readonly 'message.converted.v1': MessageConvertedV1;
  readonly 'work_item.updated.v1': WorkItemUpdatedV1;
  readonly 'work_item.blocked.v1': WorkItemBlockedV1;
  readonly 'upload.completed.v1': UploadCompletedV1;
  readonly 'usage.storage_reserved.v1': UsageStorageReservedV1;
  readonly 'usage.storage_committed.v1': UsageStorageCommittedV1;
  readonly 'usage.storage_released.v1': UsageStorageReleasedV1;
  readonly 'usage.threshold_reached.v1': UsageThresholdReachedV1;
  readonly 'file.rejected.v1': FileRejectedV1;
  readonly 'file.ready.v1': FileReadyV1;
  readonly 'file.purged.v1': FilePurgedV1;
  readonly 'work_item.created.v1': WorkItemCreatedV1;
  readonly 'work_item.client_action_requested.v1': WorkItemClientActionRequestedV1;
  readonly 'document.comment_created.v1': DocumentCommentCreatedV1;
  readonly 'document.published.v1': DocumentPublishedV1;
  readonly 'meeting.scheduled.v1': MeetingScheduledV1;
/**
 * BK3-left: ids and the pair's order only — the body stays on the row. `recipientUserId` is the
 * other participant, the one person the notice may go to; the worker re-checks them at delivery.
 */
export interface DirectMessageCreatedV1 {
  readonly directConversationId: string;
  readonly messageId: string;
  readonly sequenceNo: number;
  readonly authorUserId: string;
  readonly recipientUserId: string;
}

  readonly 'meeting.attendee_invited.v1': MeetingAttendeeInvitedV1;
  readonly 'project.member_added.v1': ProjectMemberAddedV1;
  readonly 'approval.requested.v1': ApprovalRequestedV1;
  readonly 'approval.decided.v1': ApprovalDecidedV1;
}

/**
 * CQ-12 (COL-05). The people a text mentions: every `@<userId>` token, the form the mentions
 * inbox (`my-mentions`) already searches for. Distinct, in order of first appearance, capped so a
 * pasted wall of ids cannot fan out without bound. A name typed after `@` is not a mention — only
 * an id names a person unambiguously.
 */
export const MAX_MENTIONS_PER_TEXT = 50;

const MENTION_TOKEN = /@([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/gi;

export function extractMentionedUserIds(text: string): readonly string[] {
  const ids: string[] = [];
  for (const match of text.matchAll(MENTION_TOKEN)) {
    const id = (match[1] ?? '').toLowerCase();
    if (id !== '' && !ids.includes(id)) ids.push(id);
    if (ids.length >= MAX_MENTIONS_PER_TEXT) break;
  }
  return ids;
}
  readonly 'direct_message.created.v1': DirectMessageCreatedV1;
