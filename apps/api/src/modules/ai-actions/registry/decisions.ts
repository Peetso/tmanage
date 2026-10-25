/**
 * AI action details — decisions (the decision log: propose, update, lock, supersede,
 * comment and link decisions to work).
 *
 * Slice S3 (registry wave B). Enrichment for the ops classified in `index.ts`; see `detail.ts`.
 * Decisions are governance records, so every write is confirm-class (needs the person's
 * approval); commenting notifies the decision's followers.
 */
import { det, listArgs, pathOnly, bodyArgs, f, type AiActionDetail } from './detail.js';

export const decisionsDetails: readonly AiActionDetail[] = [
  det({
    id: 'decisions.list',
    title: 'List decisions',
    description: 'The decisions recorded in this workspace.',
    input: listArgs([], { projectId: f.id().optional() }),
    redact: 'standard',
    examples: [{ summary: 'Decisions', args: {} }],
  }),
  det({
    id: 'decisions.get',
    title: 'Get a decision',
    description: 'One decision and its rationale.',
    input: pathOnly('decisionId'),
    redact: 'standard',
    examples: [{ summary: 'By id', args: { decisionId: 'dec_1' } }],
  }),
  det({
    id: 'decisions.create',
    title: 'Record a decision',
    description: 'Record a new decision. Confirm-class.',
    input: bodyArgs([], {
      title: f.shortText(300),
      statement: f.text(20_000),
      projectId: f.id().optional(),
      meetingId: f.id().optional(),
      // A15: the Decision detail page's fields.
      rationale: f.text(20_000).optional(),
      sourceMessageId: f.id().optional(),
      audience: f.shortText(40).optional(),
      // F3: who took it (an active member); the caller when absent.
      decidedBy: f.id().optional(),
    }),
    redact: 'standard',
    notifies: true,
    examples: [
      {
        summary: 'New decision',
        args: { title: 'Use MariaDB', statement: 'Live DB is MariaDB 11.8.' },
      },
    ],
  }),
  det({
    id: 'decisions.update',
    title: 'Update a decision',
    description:
      'Accept a decision, or change why it was decided and who can see it. Confirm-class.',
    input: bodyArgs(['decisionId'], {
      title: f.shortText(300).optional(),
      statement: f.text(20_000).optional(),
      status: f.shortText(40).optional(),
      // A15: the detail page's Edit (`internal` | `client_visible`).
      rationale: f.text(20_000).nullish(),
      audience: f.shortText(40).optional(),
    }),
    redact: 'standard',
    examples: [{ summary: 'Accept', args: { decisionId: 'dec_1', status: 'accepted' } }],
  }),
  det({
    id: 'decisions.comments.list',
    title: 'List decision comments',
    description: 'The comments on a decision.',
    input: listArgs(['decisionId']),
    redact: 'standard',
    examples: [{ summary: 'Comments', args: { decisionId: 'dec_1' } }],
  }),
  det({
    id: 'decisions.comments.create',
    title: 'Comment on a decision',
    description: 'Add a comment to a decision. Confirm-class; followers are notified.',
    input: bodyArgs(['decisionId'], { body: f.text(10_000) }),
    redact: 'standard',
    notifies: true,
    examples: [{ summary: 'Comment', args: { decisionId: 'dec_1', body: 'Agreed.' } }],
  }),
  det({
    id: 'decisions.comments.delete',
    title: 'Delete a decision comment',
    description: 'Delete a comment on a decision. Confirm-class.',
    input: pathOnly('decisionId', 'commentId'),
    redact: 'standard',
    examples: [{ summary: 'Delete', args: { decisionId: 'dec_1', commentId: 'cmt_2' } }],
  }),
  det({
    id: 'decisions.lock.create',
    title: 'Lock a decision',
    description: 'Lock a decision so it can no longer be edited. Confirm-class.',
    input: pathOnly('decisionId'),
    redact: 'standard',
    examples: [{ summary: 'Lock', args: { decisionId: 'dec_1' } }],
  }),
  det({
    id: 'decisions.supersede.create',
    title: 'Supersede a decision',
    description: 'Mark a decision as superseded by another. Confirm-class.',
    input: bodyArgs(['decisionId'], { supersededById: f.id().optional() }),
    redact: 'standard',
    examples: [{ summary: 'Supersede', args: { decisionId: 'dec_1', supersededById: 'dec_2' } }],
  }),
  det({
    id: 'decisions.work_links.list',
    title: 'List decision work links',
    description: 'The work items linked to a decision.',
    input: listArgs(['decisionId']),
    redact: 'standard',
    examples: [{ summary: 'Links', args: { decisionId: 'dec_1' } }],
  }),
  det({
    id: 'decisions.work_links.create',
    title: 'Link a decision to work',
    description: 'Link a work item to a decision. Confirm-class.',
    input: bodyArgs(['decisionId'], { workItemId: f.id() }),
    redact: 'standard',
    examples: [{ summary: 'Link', args: { decisionId: 'dec_1', workItemId: 'work_9' } }],
  }),
  det({
    id: 'decisions.work_links.delete',
    title: 'Remove a decision work link',
    description: 'Unlink a work item from a decision. Confirm-class.',
    input: pathOnly('decisionId', 'linkId'),
    redact: 'standard',
    examples: [{ summary: 'Unlink', args: { decisionId: 'dec_1', linkId: 'link_3' } }],
  }),
];
