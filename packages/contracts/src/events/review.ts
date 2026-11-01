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
  /**
   * R4 Batch F follow-up: the number of the file version the comment is on (1 for the root of the
   * chain), so a notice can say "v<N>" without reading the version table. Absent on events
   * written before it and on Figma frame threads.
   */
  readonly versionNo?: number;
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
  /**
   * R4 Batch F follow-up: the number of the file version the comment is on (1 for the root of the
   * chain), so a notice can say "v<N>" without reading the version table. Absent on events
   * written before it and on Figma frame threads.
   */
  readonly versionNo?: number;
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

/** `review.decision_recorded.v1` — a version of a plain file was approved, or changes asked for. */
export interface ReviewDecisionRecordedPayload {
  readonly decisionId: string;
  readonly rootFileAssetId: string;
  readonly fileAssetId: string;
  readonly projectId: string;
  readonly decision: 'approved' | 'changes_requested';
  readonly byUserId: string;
  readonly principalKind: 'internal' | 'client';
  /** R4 Batch F follow-up: the decided version's number in its chain. Absent on older events. */
  readonly versionNo?: number;
}

// ── JSON representations ──────────────────────────────────────────────────────

const CONTRACTS_BASE = 'https://contracts.tmanage.example/events';

const UUID: JsonSchemaProperty = { type: 'string', format: 'uuid' };
const NULLABLE_UUID: JsonSchemaProperty = { type: ['string', 'null'], format: 'uuid' };
const SUBJECT_TYPE: JsonSchemaProperty = { type: 'string', enum: REVIEW_SUBJECT_TYPES };
const AUDIENCE: JsonSchemaProperty = { type: 'string', enum: REVIEW_AUDIENCES };
const MENTIONS: JsonSchemaProperty = { type: 'array', items: UUID };
/** Optional: absent on events written before R4 Batch F's follow-up. */
const VERSION_NO: JsonSchemaProperty = { type: 'integer', minimum: 1 };

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
    versionNo: VERSION_NO,
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
    versionNo: VERSION_NO,
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

export const REVIEW_DECISION_RECORDED_V1_SCHEMA: JsonObjectSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: `${CONTRACTS_BASE}/review.decision_recorded.v1.schema.json`,
  title: 'review.decision_recorded.v1 payload',
  type: 'object',
  required: [
    'decisionId',
    'rootFileAssetId',
    'fileAssetId',
    'projectId',
    'decision',
    'byUserId',
    'principalKind',
  ],
  properties: {
    decisionId: UUID,
    rootFileAssetId: UUID,
    fileAssetId: UUID,
    projectId: UUID,
    decision: { type: 'string', enum: ['approved', 'changes_requested'] },
    byUserId: UUID,
    principalKind: { type: 'string', enum: ['internal', 'client'] },
    versionNo: VERSION_NO,
  },
  additionalProperties: false,
};
