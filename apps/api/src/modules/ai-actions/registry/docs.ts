/**
 * AI action details — docs (documents, collections, tags, templates, comments, reviews,
 * revisions, links, bookmarks, read-state, subscriptions, sharing, publish/unpublish).
 *
 * Slice S3 (registry wave B). Enrichment for the ops classified in `index.ts`; see `detail.ts`.
 * Document and comment bodies are untrusted member content (`standard` profile). Publishing,
 * commenting and requesting reviews notify people; destructive ops are confirm-class.
 */
import { z } from 'zod';
import { det, queryArgs, listArgs, pathOnly, bodyArgs, f, type AiActionDetail } from './detail.js';
import { DOCUMENT_BODY_FORMATS } from '../../../common/database/schema.js';
import { MAX_BODY_LENGTH as DOC_BODY_MAX } from '../../docs/doc-html.js';

/** = docs/document-template-variables.controller.ts VARIABLE_TYPES (not exported). */
const TEMPLATE_VARIABLE_TYPES = ['text', 'date', 'number'] as const;
/** = docs/reviews.controller.ts DECISION_STATES (not exported). */
const REVIEW_DECISIONS = ['approved', 'changes_requested'] as const;
/** = docs/reviews.service.ts MAX_NOTE_LENGTH (not exported). */
const REVIEW_NOTE_MAX = 60_000;

export const docsDetails: readonly AiActionDetail[] = [
  det({
    id: 'doc_collections.list',
    title: 'List document collections',
    description: 'The document collections in this workspace.',
    input: queryArgs(),
    redact: 'standard',
    examples: [{ summary: 'Collections', args: {} }],
  }),
  det({
    id: 'doc_collections.create',
    title: 'Create a document collection',
    description: 'Create a new collection to group documents.',
    input: bodyArgs([], { name: f.shortText(200) }),
    redact: 'standard',
    examples: [{ summary: 'New collection', args: { name: 'Onboarding' } }],
  }),
  det({
    id: 'doc_collections.get',
    title: 'Get a document collection',
    description: 'One collection and the documents in it.',
    input: pathOnly('collectionId'),
    redact: 'standard',
    examples: [{ summary: 'By id', args: { collectionId: 'col_1' } }],
  }),
  det({
    id: 'doc_collections.documents.set',
    title: 'Add a document to a collection',
    description: 'Put a document into a collection.',
    input: pathOnly('collectionId', 'documentId'),
    redact: 'standard',
    examples: [{ summary: 'Add', args: { collectionId: 'col_1', documentId: 'doc_9' } }],
  }),
  det({
    id: 'doc_collections.documents.delete',
    title: 'Remove a document from a collection',
    description: 'Remove a document from a collection. Confirm-class.',
    input: pathOnly('collectionId', 'documentId'),
    redact: 'standard',
    examples: [{ summary: 'Remove', args: { collectionId: 'col_1', documentId: 'doc_9' } }],
  }),
  det({
    id: 'doc_tags.list',
    title: 'List document tags',
    description: 'The document tags defined in this workspace.',
    input: queryArgs(),
    redact: 'standard',
    examples: [{ summary: 'Tags', args: {} }],
  }),
  det({
    id: 'doc_tags.create',
    title: 'Create a document tag',
    description: 'Define a new document tag.',
    input: bodyArgs([], { label: f.shortText(60), color: f.shortText(30).optional() }),
    redact: 'standard',
    examples: [{ summary: 'New tag', args: { label: 'spec' } }],
  }),
  det({
    id: 'document_bookmarks.list',
    title: 'List your document bookmarks',
    description: 'The documents you have bookmarked.',
    input: queryArgs(),
    redact: 'standard',
    examples: [{ summary: 'Bookmarks', args: {} }],
  }),
  det({
    id: 'document_read_state.list',
    title: 'List your document read state',
    description:
      'Whether you have read each of the given documents (docIds, comma-separated). No ids, ' +
      'no rows.',
    input: queryArgs([], {
      docIds: f.shortText(7_400).describe('Document ids, comma-separated'),
    }),
    redact: 'standard',
    examples: [{ summary: 'Two documents', args: { docIds: 'doc_9,doc_10' } }],
  }),
  det({
    id: 'document_templates.variables.list',
    title: 'List template variables',
    description: 'The fill-in variables defined on a document template.',
    input: listArgs(['templateId'], {}, { cursor: 'after' }),
    redact: 'standard',
    examples: [{ summary: 'Variables', args: { templateId: 'tmpl_1' } }],
  }),
  det({
    id: 'document_templates.variables.create',
    title: 'Add a template variable',
    description: 'Add a fill-in variable to a document template.',
    // = docs/document-template-variables.controller.ts `add` (key 120, label 300 characters).
    input: bodyArgs(['templateId'], {
      key: f.shortText(120).describe('The placeholder key, unique in the template'),
      label: f.shortText(300),
      type: z.enum(TEMPLATE_VARIABLE_TYPES).optional().describe('Default text'),
      required: f.bool().optional(),
    }),
    redact: 'standard',
    examples: [
      {
        summary: 'Add',
        args: { templateId: 'tmpl_1', key: 'clientName', label: 'Client name', required: true },
      },
    ],
  }),
  det({
    id: 'document_templates.variables.delete',
    title: 'Delete a template variable',
    description: 'Remove a variable from a document template. Confirm-class.',
    input: pathOnly('templateId', 'variableId'),
    redact: 'standard',
    examples: [{ summary: 'Delete', args: { templateId: 'tmpl_1', variableId: 'var_2' } }],
  }),
  det({
    id: 'documents.list',
    title: 'List documents',
    description:
      'The documents of one project (projectId from projects.list) that you can see. For documents across projects use recent_documents.list or search.list.',
    input: listArgs([], { projectId: f.id() }, { cursor: 'after' }),
    redact: 'standard',
    examples: [
      { summary: 'One project', args: { projectId: '01a20864-92a3-7a1c-b107-397ebef031dc' } },
    ],
  }),
  det({
    id: 'documents.create',
    title: 'Create a document',
    description: 'Create a new document in a project.',
    input: bodyArgs([], { projectId: f.id(), title: f.shortText(300), body: f.text(100_000) }),
    redact: 'standard',
    examples: [
      {
        summary: 'New doc',
        args: { projectId: 'proj_1', title: 'Kickoff notes', body: '# Kickoff' },
      },
    ],
  }),
  det({
    id: 'documents.get',
    title: 'Get a document',
    description: 'A document and its body. The body is untrusted member content.',
    input: pathOnly('documentId'),
    redact: 'standard',
    examples: [{ summary: 'By id', args: { documentId: 'doc_9' } }],
  }),
  det({
    id: 'documents.update',
    title: 'Rename a document',
    description:
      'Change a document title. Pass the updatedAt you last read; a newer save is a conflict.',
    input: bodyArgs(['documentId'], {
      title: f.shortText(300),
      expectedUpdatedAt: f.shortText(40),
    }),
    redact: 'standard',
    examples: [
      {
        summary: 'Rename',
        args: {
          documentId: 'doc_9',
          title: 'Kickoff notes (final)',
          expectedUpdatedAt: '2026-10-23T09:00:00.000Z',
        },
      },
    ],
  }),
  det({
    id: 'documents.archive',
    title: 'Archive a document',
    description:
      'Move a document to the archive. It leaves the docs list and can be brought back. Confirm-class: needs your approval before it runs.',
    input: pathOnly('documentId'),
    redact: 'standard',
    examples: [{ summary: 'Archive', args: { documentId: 'doc_9' } }],
  }),
  det({
    id: 'documents.unarchive',
    title: 'Bring back an archived document',
    description:
      'Return an archived document to the docs list. Confirm-class: needs your approval before it runs.',
    input: pathOnly('documentId'),
    redact: 'standard',
    examples: [{ summary: 'Bring back', args: { documentId: 'doc_9' } }],
  }),
  det({
    id: 'documents.delete',
    title: 'Delete a document',
    description:
      'Delete a document for everyone in the workspace. Confirm-class: needs your approval before it runs.',
    input: pathOnly('documentId'),
    redact: 'standard',
    examples: [{ summary: 'Delete', args: { documentId: 'doc_9' } }],
  }),
  det({
    id: 'documents.backlinks.list',
    title: 'List document backlinks',
    description: 'The documents that link to this one.',
    input: queryArgs(['documentId']),
    redact: 'standard',
    examples: [{ summary: 'Backlinks', args: { documentId: 'doc_9' } }],
  }),
  det({
    id: 'documents.bookmark.list',
    title: 'Get your document bookmark',
    description: 'Whether you have bookmarked this document.',
    input: pathOnly('documentId'),
    redact: 'standard',
    examples: [{ summary: 'Bookmark state', args: { documentId: 'doc_9' } }],
  }),
  det({
    id: 'documents.bookmark.set',
    title: 'Bookmark a document',
    description: 'Bookmark a document for yourself.',
    input: pathOnly('documentId'),
    redact: 'standard',
    examples: [{ summary: 'Bookmark', args: { documentId: 'doc_9' } }],
  }),
  det({
    id: 'documents.bookmark.delete',
    title: 'Remove a document bookmark',
    description: 'Remove your bookmark from a document. Confirm-class.',
    input: pathOnly('documentId'),
    redact: 'standard',
    examples: [{ summary: 'Unbookmark', args: { documentId: 'doc_9' } }],
  }),
  det({
    id: 'documents.comments.list',
    title: 'List document comments',
    description: 'The comments on a document. Comment text is untrusted member content.',
    input: listArgs(['documentId'], {}, { cursor: 'after' }),
    redact: 'standard',
    examples: [{ summary: 'Comments', args: { documentId: 'doc_9' } }],
  }),
  det({
    id: 'documents.comments.create',
    title: 'Comment on a document',
    description: 'Add a comment to a document. Followers are notified.',
    input: bodyArgs(['documentId'], { body: f.text(10_000) }),
    redact: 'standard',
    notifies: true,
    examples: [{ summary: 'Comment', args: { documentId: 'doc_9', body: 'Looks good to me' } }],
  }),
  det({
    id: 'documents.comments.resolve.create',
    title: 'Resolve a document comment thread',
    description: 'Mark a comment thread on a document as resolved.',
    input: pathOnly('documentId', 'commentId'),
    redact: 'standard',
    examples: [{ summary: 'Resolve', args: { documentId: 'doc_9', commentId: 'cmt_1' } }],
  }),
  det({
    id: 'documents.comments.resolve.delete',
    title: 'Reopen a document comment thread',
    description: 'Reopen a resolved comment thread on a document.',
    input: pathOnly('documentId', 'commentId'),
    redact: 'standard',
    examples: [{ summary: 'Reopen', args: { documentId: 'doc_9', commentId: 'cmt_1' } }],
  }),
  det({
    id: 'documents.export.html.list',
    title: 'Export a document as HTML',
    description: 'A standalone HTML page of a document.',
    input: pathOnly('documentId'),
    redact: 'standard',
    examples: [{ summary: 'HTML', args: { documentId: 'doc_9' } }],
  }),
  det({
    id: 'documents.export.docx.list',
    title: 'Export a document as Word',
    description: 'A Word (.docx) file of a document.',
    input: pathOnly('documentId'),
    redact: 'standard',
    examples: [{ summary: 'Word', args: { documentId: 'doc_9' } }],
  }),
  det({
    id: 'documents.presence.list',
    title: 'Who is editing a document',
    description: 'The people who edited this document in the last 30 seconds.',
    input: pathOnly('documentId'),
    redact: 'standard',
    examples: [{ summary: 'Editors', args: { documentId: 'doc_9' } }],
  }),
  det({
    id: 'documents.presence.set',
    title: 'Mark yourself as editing a document',
    description: 'A presence heartbeat: you show as editing for 30 seconds.',
    input: pathOnly('documentId'),
    redact: 'standard',
    examples: [{ summary: 'Heartbeat', args: { documentId: 'doc_9' } }],
  }),
  det({
    id: 'documents.export.md.list',
    title: 'Export a document as Markdown',
    description: 'The Markdown text of a document.',
    input: pathOnly('documentId'),
    redact: 'standard',
    examples: [{ summary: 'Markdown', args: { documentId: 'doc_9' } }],
  }),
  det({
    id: 'documents.links.list',
    title: 'List document links',
    description: 'The documents linked from this one.',
    input: queryArgs(['documentId']),
    redact: 'standard',
    examples: [{ summary: 'Links', args: { documentId: 'doc_9' } }],
  }),
  det({
    id: 'documents.links.create',
    title: 'Link a document to another',
    description: 'Create a link from this document to another document.',
    input: bodyArgs(['documentId'], { targetDocId: f.id() }),
    redact: 'standard',
    examples: [{ summary: 'Link', args: { documentId: 'doc_9', targetDocId: 'doc_10' } }],
  }),
  det({
    id: 'documents.links.delete',
    title: 'Remove a document link',
    description: 'Remove a link between documents. Confirm-class.',
    input: pathOnly('documentId', 'targetDocId'),
    redact: 'standard',
    examples: [{ summary: 'Unlink', args: { documentId: 'doc_9', targetDocId: 'doc_10' } }],
  }),
  det({
    id: 'documents.publish',
    title: 'Publish a document',
    description:
      'Publish a document so it is shared more widely. Confirm-class; subscribers are notified.',
    input: pathOnly('documentId'),
    redact: 'standard',
    notifies: true,
    examples: [{ summary: 'Publish', args: { documentId: 'doc_9' } }],
  }),
  det({
    id: 'documents.unpublish.create',
    title: 'Unpublish a document',
    description: 'Take a published document back to draft.',
    input: pathOnly('documentId'),
    redact: 'standard',
    examples: [{ summary: 'Unpublish', args: { documentId: 'doc_9' } }],
  }),
  det({
    id: 'documents.read.set',
    title: 'Mark a document read',
    description: 'Mark a document read, for yourself.',
    input: pathOnly('documentId'),
    redact: 'standard',
    examples: [{ summary: 'Mark read', args: { documentId: 'doc_9' } }],
  }),
  det({
    id: 'documents.read.delete',
    title: 'Mark a document unread',
    description: 'Clear your read mark on a document. Confirm-class.',
    input: pathOnly('documentId'),
    redact: 'standard',
    examples: [{ summary: 'Mark unread', args: { documentId: 'doc_9' } }],
  }),
  det({
    id: 'documents.restore',
    title: 'Restore a document version',
    description:
      'Bring back an earlier version of a document as a new version (history is kept). ' +
      'versionNo is from documents.versions.list.',
    input: bodyArgs(['documentId'], { versionNo: f.int(1) }),
    redact: 'standard',
    examples: [{ summary: 'Restore', args: { documentId: 'doc_9', versionNo: 2 } }],
  }),
  det({
    id: 'documents.reviews.list',
    title: 'List document reviews',
    description: 'The review requests on a document.',
    input: listArgs(['documentId'], {}, { cursor: 'after' }),
    redact: 'standard',
    examples: [{ summary: 'Reviews', args: { documentId: 'doc_9' } }],
  }),
  det({
    id: 'documents.reviews.create',
    title: 'Request a document review',
    description: 'Ask one person to review a document, with an optional note. They are notified.',
    input: bodyArgs(['documentId'], {
      reviewerUserId: f.id(),
      note: f.text(REVIEW_NOTE_MAX).optional(),
    }),
    redact: 'standard',
    notifies: true,
    examples: [{ summary: 'Request', args: { documentId: 'doc_9', reviewerUserId: 'user_3' } }],
  }),
  det({
    id: 'documents.reviews.set',
    title: 'Record a document review decision',
    description:
      'Record your review decision on a document: approved, or changes_requested with a note ' +
      'saying why.',
    // = docs/reviews.controller.ts `decide`.
    input: (
      bodyArgs(['documentId', 'reviewId'], {
        state: z.enum(REVIEW_DECISIONS),
        note: f.text(REVIEW_NOTE_MAX).optional(),
      }) as z.ZodObject<z.ZodRawShape>
    ).refine(
      (v: Record<string, unknown>) =>
        v['state'] !== 'changes_requested' ||
        (typeof v['note'] === 'string' && v['note'].trim() !== ''),
      { message: 'a note is required when requesting changes', path: ['note'] },
    ),
    redact: 'standard',
    examples: [
      {
        summary: 'Approve',
        args: { documentId: 'doc_9', reviewId: 'rev_1', state: 'approved' },
      },
      {
        summary: 'Ask for changes',
        args: {
          documentId: 'doc_9',
          reviewId: 'rev_1',
          state: 'changes_requested',
          note: 'Please add the budget table',
        },
      },
    ],
  }),
  det({
    id: 'documents.revisions.list',
    title: 'List document revisions',
    description: 'The saved revisions of a document.',
    input: queryArgs(['documentId']),
    redact: 'standard',
    examples: [{ summary: 'Revisions', args: { documentId: 'doc_9' } }],
  }),
  det({
    id: 'documents.revisions.create',
    title: 'Save a document revision',
    description: 'Save a revision snapshot of a document: bodySnapshot is the full body to keep.',
    // = docs/revisions.controller.ts `capture` (MAX_BODY_LENGTH 1 000 000).
    input: bodyArgs(['documentId'], { bodySnapshot: f.text(1_000_000) }),
    redact: 'standard',
    examples: [
      { summary: 'Snapshot', args: { documentId: 'doc_9', bodySnapshot: '# Plan\n\nDraft one.' } },
    ],
  }),
  det({
    id: 'documents.revisions.restore',
    title: 'Restore a document revision',
    description: 'Restore the document to an earlier revision.',
    input: pathOnly('documentId', 'revId'),
    redact: 'standard',
    examples: [{ summary: 'Restore', args: { documentId: 'doc_9', revId: 'rev_4' } }],
  }),
  det({
    id: 'documents.sharing.list',
    title: 'List document sharing',
    description: 'Who a document is shared with.',
    input: pathOnly('documentId'),
    redact: 'standard',
    examples: [{ summary: 'Sharing', args: { documentId: 'doc_9' } }],
  }),
  det({
    id: 'documents.subscription.list',
    title: 'Get your document subscription',
    description: 'Whether you follow a document for updates.',
    input: pathOnly('documentId'),
    redact: 'standard',
    examples: [{ summary: 'Subscription', args: { documentId: 'doc_9' } }],
  }),
  det({
    id: 'documents.subscription.set',
    title: 'Follow a document',
    description: 'Follow a document to get its updates.',
    input: pathOnly('documentId'),
    redact: 'standard',
    examples: [{ summary: 'Follow', args: { documentId: 'doc_9' } }],
  }),
  det({
    id: 'documents.subscription.delete',
    title: 'Unfollow a document',
    description: 'Stop following a document. Confirm-class.',
    input: pathOnly('documentId'),
    redact: 'standard',
    examples: [{ summary: 'Unfollow', args: { documentId: 'doc_9' } }],
  }),
  det({
    id: 'documents.tags.list',
    title: 'List a document’s tags',
    description: 'The tags on a document.',
    input: pathOnly('documentId'),
    redact: 'standard',
    examples: [{ summary: 'Tags', args: { documentId: 'doc_9' } }],
  }),
  det({
    id: 'documents.tags.set',
    title: 'Tag a document',
    description: 'Add a tag to a document.',
    input: pathOnly('documentId', 'tagId'),
    redact: 'standard',
    examples: [{ summary: 'Tag', args: { documentId: 'doc_9', tagId: 'tag_2' } }],
  }),
  det({
    id: 'documents.tags.delete',
    title: 'Untag a document',
    description: 'Remove a tag from a document. Confirm-class.',
    input: pathOnly('documentId', 'tagId'),
    redact: 'standard',
    examples: [{ summary: 'Untag', args: { documentId: 'doc_9', tagId: 'tag_2' } }],
  }),
  det({
    id: 'documents.versions.list',
    title: 'List document versions',
    description: 'The published versions of a document.',
    input: queryArgs(['documentId']),
    redact: 'standard',
    examples: [{ summary: 'Versions', args: { documentId: 'doc_9' } }],
  }),
  det({
    id: 'documents.versions.create',
    title: 'Publish a document version',
    description:
      'Save a new version of a document with this body (markdown by default). Send ' +
      'expectedVersionNo (the latest versionNo you read) to be refused if someone saved meanwhile.',
    // = docs/documents.controller.ts `saveVersion`.
    input: bodyArgs(['documentId'], {
      body: f.text(DOC_BODY_MAX),
      format: z.enum(DOCUMENT_BODY_FORMATS).optional(),
      expectedVersionNo: f.int(0).optional(),
    }),
    redact: 'standard',
    examples: [
      {
        summary: 'Version',
        args: { documentId: 'doc_9', body: '# Plan\n\nFinal.', expectedVersionNo: 3 },
      },
    ],
  }),
  det({
    id: 'documents.versions.get',
    title: 'Get a document version',
    description: 'One published version of a document.',
    input: pathOnly('documentId', 'versionNo'),
    redact: 'standard',
    examples: [{ summary: 'By number', args: { documentId: 'doc_9', versionNo: '1' } }],
  }),
  det({
    id: 'documents.templates.list',
    title: 'List document templates',
    description: 'The document templates in this workspace.',
    input: listArgs([], {}, { cursor: 'after' }),
    redact: 'standard',
    examples: [{ summary: 'Templates', args: {} }],
  }),
  det({
    id: 'documents.templates.create',
    title: 'Create a document template',
    description: 'Create a reusable document template: a name, what it is for, and its body.',
    // = docs/documents.controller.ts `createTemplate` (MAX_TITLE_LENGTH 300, body 60 000).
    input: bodyArgs([], {
      name: f.shortText(300),
      purpose: f.shortText(300),
      body: f.text(60_000),
    }),
    redact: 'standard',
    examples: [
      {
        summary: 'New template',
        args: { name: 'Meeting notes', purpose: 'Weekly client meeting', body: '# Agenda' },
      },
    ],
  }),
  det({
    id: 'documents.templates.apply.create',
    title: 'Create a document from a template',
    description: 'Create a new document in a project from a template.',
    input: bodyArgs(['templateId'], {
      projectId: f.id(),
      title: f.shortText(300).optional(),
    }),
    redact: 'standard',
    examples: [{ summary: 'Apply', args: { templateId: 'tmpl_1', projectId: 'proj_1' } }],
  }),
];
