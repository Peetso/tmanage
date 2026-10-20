/**
 * AI action details — files (file metadata, comments, folders and tags).
 *
 * Slice S3 (registry wave B). Enrichment for the ops classified in `index.ts`; see `detail.ts`.
 * Download is **link only**: `files.content` is confirm-class and returns a short-lived signed
 * URL (never file bytes), issued only after the person approves it (architecture B4). The
 * signed-link result shape is produced by `redact.ts` (S6), which must emit a link for this op
 * and strip storage keys/internal paths for every file result. No op takes a URL to fetch (B5).
 */
import { det, listArgs, pathOnly, bodyArgs, f, type AiActionDetail } from './detail.js';

export const filesDetails: readonly AiActionDetail[] = [
  det({
    id: 'file_tags.list',
    title: 'List file tags',
    description: 'The file tags defined in this workspace.',
    input: listArgs(),
    redact: 'standard',
    examples: [{ summary: 'Tags', args: {} }],
  }),
  det({
    id: 'file_tags.create',
    title: 'Create a file tag',
    description: 'Define a new file tag.',
    input: bodyArgs([], { label: f.shortText(60), color: f.shortText(30).optional() }),
    redact: 'standard',
    examples: [{ summary: 'New tag', args: { label: 'contract' } }],
  }),
  det({
    id: 'files.content.list',
    title: 'Get a file download link',
    description:
      'Get a short-lived download link for a file. Confirm-class: the link is issued only after ' +
      'you approve it, and the AI never receives the file contents.',
    input: pathOnly('fileAssetId'),
    redact: 'standard',
    examples: [{ summary: 'Download link', args: { fileAssetId: 'file_7' } }],
  }),
  det({
    id: 'files.comments.list',
    title: 'List file comments',
    description: 'The comments on a file. Comment text is untrusted member content.',
    input: listArgs(['fileId']),
    redact: 'standard',
    examples: [{ summary: 'Comments', args: { fileId: 'file_7' } }],
  }),
  det({
    id: 'files.comments.create',
    title: 'Comment on a file',
    description: 'Add a comment to a file. Followers are notified.',
    input: bodyArgs(['fileId'], { body: f.text(10_000) }),
    redact: 'standard',
    notifies: true,
    examples: [{ summary: 'Comment', args: { fileId: 'file_7', body: 'Signed copy attached' } }],
  }),
  det({
    id: 'files.comments.delete',
    title: 'Delete a file comment',
    description: 'Delete a comment on a file. Confirm-class.',
    input: pathOnly('fileId', 'commentId'),
    redact: 'standard',
    examples: [{ summary: 'Delete', args: { fileId: 'file_7', commentId: 'cmt_2' } }],
  }),
  det({
    id: 'files.folder.set',
    title: 'Move a file to a folder',
    description: 'Move a file into a folder.',
    input: bodyArgs(['fileId'], { folderId: f.id() }),
    redact: 'standard',
    examples: [{ summary: 'Move', args: { fileId: 'file_7', folderId: 'fold_1' } }],
  }),
  det({
    id: 'files.tags.list',
    title: 'List a file’s tags',
    description: 'The tags on a file.',
    input: pathOnly('fileId'),
    redact: 'standard',
    examples: [{ summary: 'Tags', args: { fileId: 'file_7' } }],
  }),
  det({
    id: 'files.tags.set',
    title: 'Tag a file',
    description: 'Add a tag to a file.',
    input: pathOnly('fileId', 'tagId'),
    redact: 'standard',
    examples: [{ summary: 'Tag', args: { fileId: 'file_7', tagId: 'tag_2' } }],
  }),
  det({
    id: 'files.tags.delete',
    title: 'Untag a file',
    description: 'Remove a tag from a file. Confirm-class.',
    input: pathOnly('fileId', 'tagId'),
    redact: 'standard',
    examples: [{ summary: 'Untag', args: { fileId: 'file_7', tagId: 'tag_2' } }],
  }),
];
