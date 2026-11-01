/**
 * Versioned `review.*` event payload schemas — R4 slice 5, the proofing viewer's threads.
 *
 * The api emits these from `apps/api/src/modules/files/review.service.ts` inside the transaction
 * that writes the thread or comment (`packages/domain/src/events/outbox.ts` holds the producer's
 * TypeScript shapes). Ids and states only: the comment text never travels in an event; a consumer
 * re-reads it under current permissions. `subjectId` is the root file asset of the version chain.
 */
import type { JsonObjectSchema, JsonSchemaProperty } from './json-schema.js';

export const REVIEW_SUBJECT_TYPES = ['file_asset', 'figma_frame'] as const;
export type ReviewSubjectType = (typeof REVIEW_SUBJECT_TYPES)[number];

export const REVIEW_AUDIENCES = ['internal', 'client_visible'] as const;
export type ReviewAudience = (typeof REVIEW_AUDIENCES)[number];

// ── Payload types ────────────────────────────────────────────────────────────

/** `review.thread_created.v1` — a thread was opened with its first comment. */
export interface ReviewThreadCreatedPayload {
  readonly threadId: string;
  readonly commentId: string;
  readonly subjectType: ReviewSubjectType;
  readonly subjectId: string;
  readonly fileAssetId: string | null;
  readonly projectId: string;
  readonly audience: ReviewAudience;
  readonly authorUserId: string;
  readonly mentionedUserIds: readonly string[];
}

/** `review.comment_added.v1` — a reply on a thread. */
export interface ReviewCommentAddedPayload {
  readonly commentId: string;
  readonly threadId: string;
  readonly subjectType: ReviewSubjectType;
  readonly subjectId: string;
  readonly fileAssetId: string | null;
  readonly projectId: string;
  readonly audience: ReviewAudience;
  readonly authorUserId: string;
  readonly mentionedUserIds: readonly string[];
}

/** `review.thread_resolved.v1` — a thread was resolved (`resolved: true`) or reopened. */
export interface ReviewThreadResolvedPayload {
  readonly threadId: string;
  readonly subjectType: ReviewSubjectType;
  readonly subjectId: string;
  readonly projectId: string;
  readonly audience: ReviewAudience;
  readonly resolved: boolean;
  readonly byUserId: string;
}

// ── JSON representations ──────────────────────────────────────────────────────

const CONTRACTS_BASE = 'https://contracts.tmanage.example/events';

const UUID: JsonSchemaProperty = { type: 'string', format: 'uuid' };
const NULLABLE_UUID: JsonSchemaProperty = { type: ['string', 'null'], format: 'uuid' };
const SUBJECT_TYPE: JsonSchemaProperty = { type: 'string', enum: REVIEW_SUBJECT_TYPES };
const AUDIENCE: JsonSchemaProperty = { type: 'string', enum: REVIEW_AUDIENCES };
const MENTIONS: JsonSchemaProperty = { type: 'array', items: UUID };

export const REVIEW_THREAD_CREATED_V1_SCHEMA: JsonObjectSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: `${CONTRACTS_BASE}/review.thread_created.v1.schema.json`,
  title: 'review.thread_created.v1 payload',
  type: 'object',
  required: [
    'threadId',
    'commentId',
    'subjectType',
    'subjectId',
    'fileAssetId',
    'projectId',
    'audience',
    'authorUserId',
    'mentionedUserIds',
  ],
  properties: {
    threadId: UUID,
    commentId: UUID,
    subjectType: SUBJECT_TYPE,
    subjectId: UUID,
    fileAssetId: NULLABLE_UUID,
    projectId: UUID,
    audience: AUDIENCE,
    authorUserId: UUID,
    mentionedUserIds: MENTIONS,
  },
  additionalProperties: false,
};

export const REVIEW_COMMENT_ADDED_V1_SCHEMA: JsonObjectSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: `${CONTRACTS_BASE}/review.comment_added.v1.schema.json`,
  title: 'review.comment_added.v1 payload',
  type: 'object',
  required: [
    'commentId',
    'threadId',
    'subjectType',
    'subjectId',
    'fileAssetId',
    'projectId',
    'audience',
    'authorUserId',
    'mentionedUserIds',
  ],
  properties: {
    commentId: UUID,
    threadId: UUID,
    subjectType: SUBJECT_TYPE,
    subjectId: UUID,
    fileAssetId: NULLABLE_UUID,
    projectId: UUID,
    audience: AUDIENCE,
    authorUserId: UUID,
    mentionedUserIds: MENTIONS,
  },
  additionalProperties: false,
};

export const REVIEW_THREAD_RESOLVED_V1_SCHEMA: JsonObjectSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: `${CONTRACTS_BASE}/review.thread_resolved.v1.schema.json`,
  title: 'review.thread_resolved.v1 payload',
  type: 'object',
  required: [
    'threadId',
    'subjectType',
    'subjectId',
    'projectId',
    'audience',
    'resolved',
    'byUserId',
  ],
  properties: {
    threadId: UUID,
    subjectType: SUBJECT_TYPE,
    subjectId: UUID,
    projectId: UUID,
    audience: AUDIENCE,
    resolved: { type: 'boolean' },
    byUserId: UUID,
  },
  additionalProperties: false,
};
