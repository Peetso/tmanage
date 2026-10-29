import type { AuditAction } from '@tmanage/domain';

/**
 * platform-admin v2 · PA-08 — every kind of customer content the browser shows, and the table,
 * the audit actions and the soft-delete columns behind it (0245).
 *
 * One registry, so a kind added to the trash is added to delete and restore at the same time, and
 * a kind that cannot be edited says so here rather than in four places.
 */

export const CONTENT_AREAS = [
  'chats',
  'dms',
  'work_items',
  'comments',
  'docs',
  'decisions',
  'meetings',
  'files',
  'requests',
] as const;
export type ContentArea = (typeof CONTENT_AREAS)[number];

export const CONTENT_KINDS = [
  'message',
  'direct_message',
  'work_item',
  'work_comment',
  'doc_comment',
  'decision_comment',
  'file_comment',
  'request_comment',
  'update_comment',
  'doc',
  'decision',
  'meeting',
  'file',
  'drive_file',
  'onedrive_file',
  'request_message',
] as const;
export type ContentKind = (typeof CONTENT_KINDS)[number];

export function isContentKind(value: unknown): value is ContentKind {
  return typeof value === 'string' && (CONTENT_KINDS as readonly string[]).includes(value);
}

/** The comment kinds, by the short name the `comments/:kind/:commentId` route uses. */
export const COMMENT_KINDS = {
  work: 'work_comment',
  doc: 'doc_comment',
  decision: 'decision_comment',
  file: 'file_comment',
  request: 'request_comment',
  update: 'update_comment',
} as const satisfies Record<string, ContentKind>;
export type CommentRouteKind = keyof typeof COMMENT_KINDS;

export function commentKindOf(raw: unknown): ContentKind | null {
  if (typeof raw !== 'string') return null;
  if (Object.hasOwn(COMMENT_KINDS, raw)) return COMMENT_KINDS[raw as CommentRouteKind];
  return isContentKind(raw) && raw.endsWith('_comment') ? raw : null;
}

export interface ContentKindDefinition {
  readonly table: string;
  /** The column holding the text a trash row previews. */
  readonly titleColumn: string;
  /** The column naming who wrote it: a user id, or a membership id (`author_membership_id`). */
  readonly authorColumn: string | null;
  readonly authorIsMembership: boolean;
  readonly deleteAction: AuditAction;
  readonly restoreAction: AuditAction;
  /** The area tab it belongs to. */
  readonly area: ContentArea;
  /** Rows of an append-only table (0245 triggers): only the soft-delete columns may change. */
  readonly appendOnly: boolean;
}

export const CONTENT_KIND_DEFINITIONS: Readonly<Record<ContentKind, ContentKindDefinition>> = {
  message: {
    table: 'messages',
    titleColumn: 'body',
    authorColumn: 'author_user_id',
    authorIsMembership: false,
    deleteAction: 'message.deleted',
    restoreAction: 'message.restored',
    area: 'chats',
    appendOnly: false,
  },
  direct_message: {
    table: 'direct_messages',
    titleColumn: 'body',
    authorColumn: 'author_user_id',
    authorIsMembership: false,
    deleteAction: 'direct_message.deleted',
    restoreAction: 'direct_message.restored',
    area: 'dms',
    appendOnly: true,
  },
  work_item: {
    table: 'work_items',
    titleColumn: 'title',
    authorColumn: 'owner_user_id',
    authorIsMembership: false,
    deleteAction: 'work_item.deleted',
    restoreAction: 'work_item.restored',
    area: 'work_items',
    appendOnly: false,
  },
  work_comment: {
    table: 'work_item_comments',
    titleColumn: 'body',
    authorColumn: 'author_membership_id',
    authorIsMembership: true,
    deleteAction: 'comment.deleted',
    restoreAction: 'comment.restored',
    area: 'comments',
    appendOnly: true,
  },
  doc_comment: {
    table: 'document_comments',
    titleColumn: 'body',
    authorColumn: 'author_membership_id',
    authorIsMembership: true,
    deleteAction: 'comment.deleted',
    restoreAction: 'comment.restored',
    area: 'comments',
    appendOnly: true,
  },
  decision_comment: {
    table: 'decision_comments',
    titleColumn: 'body',
    authorColumn: 'author_membership_id',
    authorIsMembership: true,
    deleteAction: 'comment.deleted',
    restoreAction: 'comment.restored',
    area: 'comments',
    appendOnly: true,
  },
  file_comment: {
    table: 'file_comments',
    titleColumn: 'body',
    authorColumn: 'created_by',
    authorIsMembership: false,
    deleteAction: 'comment.deleted',
    restoreAction: 'comment.restored',
    area: 'comments',
    appendOnly: true,
  },
  request_comment: {
    table: 'request_comments',
    titleColumn: 'body',
    authorColumn: 'author_membership_id',
    authorIsMembership: true,
    deleteAction: 'comment.deleted',
    restoreAction: 'comment.restored',
    area: 'comments',
    appendOnly: true,
  },
  update_comment: {
    table: 'project_update_comments',
    titleColumn: 'body',
    authorColumn: 'created_by_user_id',
    authorIsMembership: false,
    deleteAction: 'comment.deleted',
    restoreAction: 'comment.restored',
    area: 'comments',
    appendOnly: true,
  },
  doc: {
    table: 'documents',
    titleColumn: 'title',
    authorColumn: 'created_by_user_id',
    authorIsMembership: false,
    deleteAction: 'document.deleted',
    restoreAction: 'document.restored',
    area: 'docs',
    appendOnly: false,
  },
  decision: {
    table: 'decisions',
    titleColumn: 'title',
    authorColumn: null,
    authorIsMembership: false,
    deleteAction: 'decision.deleted',
    restoreAction: 'decision.restored',
    area: 'decisions',
    appendOnly: false,
  },
  meeting: {
    table: 'meetings',
    titleColumn: 'title',
    authorColumn: 'created_by_user_id',
    authorIsMembership: false,
    deleteAction: 'meeting.deleted',
    restoreAction: 'meeting.restored',
    area: 'meetings',
    appendOnly: false,
  },
  file: {
    table: 'file_assets',
    titleColumn: 'name',
    authorColumn: 'owner_user_id',
    authorIsMembership: false,
    deleteAction: 'file_asset.deleted',
    restoreAction: 'file_asset.restored',
    area: 'files',
    appendOnly: false,
  },
  drive_file: {
    table: 'google_drive_attachments',
    titleColumn: 'name',
    authorColumn: 'attached_by_user_id',
    authorIsMembership: false,
    deleteAction: 'attachment.deleted',
    restoreAction: 'attachment.restored',
    area: 'files',
    appendOnly: false,
  },
  onedrive_file: {
    table: 'onedrive_attachments',
    titleColumn: 'name',
    authorColumn: 'attached_by_user_id',
    authorIsMembership: false,
    deleteAction: 'attachment.deleted',
    restoreAction: 'attachment.restored',
    area: 'files',
    appendOnly: false,
  },
  request_message: {
    table: 'request_messages',
    titleColumn: 'body',
    authorColumn: 'author_membership_id',
    authorIsMembership: true,
    deleteAction: 'request_message.deleted',
    restoreAction: 'request_message.restored',
    area: 'requests',
    appendOnly: true,
  },
};

/** The kinds whose text a support admin may change (the rest refuse with an explanation). */
export const EDITABLE_KINDS: readonly ContentKind[] = [
  'message',
  'work_item',
  'doc',
  'decision',
  'meeting',
];

/** The kinds on the B7 trash list, in the order the kind filter offers them. */
export const TRASH_KINDS: readonly ContentKind[] = CONTENT_KINDS;
