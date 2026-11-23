/**
 * AI action details — requests (the `client_requests` module: client-raised requests, their
 * comments, history, tags, transitions, acceptance and triage).
 *
 * Slice S3 (registry wave B). Enrichment for the ops classified in `index.ts`; see `detail.ts`.
 * The request record, comments and history are shared with the client, so they use the
 * `client_safe` profile; internal triage stays `standard`. Commenting, transitioning and
 * accepting notify the client.
 */
import { AUDIENCES, CLIENT_REQUEST_STATES } from '@tmanage/domain';
import { z } from 'zod';
import {
  MAX_CLARIFICATION_LENGTH,
  MAX_REASON_LENGTH,
  MAX_SCOPE_SUMMARY_LENGTH,
} from '../../requests/client-request-input.js';
import { det, queryArgs, listArgs, pathOnly, bodyArgs, f, type AiActionDetail } from './detail.js';

/** A calendar day on the wire, `YYYY-MM-DD` (requests/client-request-input.ts parseCalendarDay). */
const day = () => z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'must be a YYYY-MM-DD date');
/** = requests/client-request-input.ts parseCommitment: `unscheduled` or a committed day. */
const commitment = () =>
  z
    .union([z.literal('unscheduled'), day()])
    .describe("When the work will be done: 'unscheduled' or a YYYY-MM-DD date");
/** = requests/client-request-input.ts requiredVersion. */
const version = () =>
  f
    .int(1, 2_147_483_647)
    .describe('The request’s current version, from client_requests.get or the list');
// = common/database/schema.ts:REQUEST_TRIAGE_CATEGORIES
const triageCategory = z.enum([
  'general',
  'bug',
  'change_request',
  'question',
  'billing',
  'feedback',
]);

export const requestsDetails: readonly AiActionDetail[] = [
  det({
    id: 'client_requests.list',
    title: 'List client requests',
    description: 'The requests raised by clients that you can see, optionally filtered.',
    input: listArgs(
      [],
      {
        projectId: f.id().optional(),
        clientOrganizationId: f.id().optional(),
        state: f
          .shortText(300)
          .optional()
          .describe(`States separated by commas, from: ${CLIENT_REQUEST_STATES.join(', ')}`),
      },
      { cursor: 'after' },
    ),
    redact: 'client_safe',
    examples: [{ summary: 'Open requests', args: { state: 'submitted,triage' } }],
  }),
  det({
    id: 'client_requests.get',
    title: 'Get a client request',
    description: 'One client request by id.',
    input: pathOnly('clientRequestId'),
    redact: 'client_safe',
    examples: [{ summary: 'By id', args: { clientRequestId: 'creq_1' } }],
  }),
  det({
    id: 'client_requests.acceptance.create',
    title: 'Accept a client request',
    description:
      'Accept a client request and commit the work in one step: a client-safe scope summary and ' +
      'when it will be done. Either link an existing work item or describe the new one (work), not ' +
      'both. The client is notified unless notifyClient is false.',
    input: bodyArgs(['clientRequestId'], {
      version: version(),
      clientSafeScopeSummary: f.text(MAX_SCOPE_SUMMARY_LENGTH),
      commitment: commitment(),
      linkedWorkItemId: f.id().optional(),
      work: z
        .object({
          title: f.shortText(300).optional(),
          audience: z.enum(AUDIENCES).optional(),
          ownerUserId: f.id().optional(),
        })
        .strict()
        .optional(),
      notifyClient: f.bool().optional(),
    }),
    redact: 'client_safe',
    notifies: true,
    examples: [
      {
        summary: 'Accept',
        args: {
          clientRequestId: 'creq_1',
          version: 3,
          clientSafeScopeSummary: 'We will redesign the pricing page.',
          commitment: '2026-12-05',
        },
      },
    ],
  }),
  det({
    id: 'client_requests.comments.list',
    title: 'List client request comments',
    description: 'The comments on a client request. Comment text is untrusted member content.',
    input: queryArgs(['clientRequestId']),
    redact: 'client_safe',
    examples: [{ summary: 'Comments', args: { clientRequestId: 'creq_1' } }],
  }),
  det({
    id: 'client_requests.comments.create',
    title: 'Comment on a client request',
    description: 'Add a comment to a client request. The client is notified.',
    input: bodyArgs(['clientRequestId'], { body: f.text(10_000) }),
    redact: 'client_safe',
    notifies: true,
    examples: [{ summary: 'Reply', args: { clientRequestId: 'creq_1', body: 'We are on it.' } }],
  }),
  det({
    id: 'client_requests.comments.delete',
    title: 'Delete a client request comment',
    description: 'Delete a comment on a client request. Confirm-class.',
    input: pathOnly('clientRequestId', 'commentId'),
    redact: 'client_safe',
    examples: [{ summary: 'Delete', args: { clientRequestId: 'creq_1', commentId: 'cmt_2' } }],
  }),
  det({
    id: 'client_requests.history.list',
    title: 'Get client request history',
    description: 'The change history of a client request.',
    input: queryArgs(['clientRequestId']),
    redact: 'client_safe',
    examples: [{ summary: 'History', args: { clientRequestId: 'creq_1' } }],
  }),
  det({
    id: 'client_requests.tags.list',
    title: 'List a client request’s tags',
    description: 'The tags on a client request.',
    input: queryArgs(['clientRequestId']),
    redact: 'standard',
    examples: [{ summary: 'Tags', args: { clientRequestId: 'creq_1' } }],
  }),
  det({
    id: 'client_requests.tags.create',
    title: 'Tag a client request',
    description: 'Add a tag to a client request.',
    input: bodyArgs(['clientRequestId'], { tagId: f.id() }),
    redact: 'standard',
    examples: [{ summary: 'Tag', args: { clientRequestId: 'creq_1', tagId: 'tag_2' } }],
  }),
  det({
    id: 'client_requests.tags.delete',
    title: 'Untag a client request',
    description: 'Remove a tag from a client request. Confirm-class.',
    input: pathOnly('clientRequestId', 'tagId'),
    redact: 'standard',
    examples: [{ summary: 'Untag', args: { clientRequestId: 'creq_1', tagId: 'tag_2' } }],
  }),
  det({
    id: 'client_requests.transitions.create',
    title: 'Move a client request',
    description:
      'Move a client request to a new state (accepting has its own action). deferUntil and ' +
      'remindOnReopen only on a move to deferred. The client may be notified.',
    input: bodyArgs(['clientRequestId'], {
      version: version(),
      to: z.enum(CLIENT_REQUEST_STATES).exclude(['accepted']),
      clarificationQuestion: f.text(MAX_CLARIFICATION_LENGTH).optional(),
      clientVisibleReason: f.text(MAX_REASON_LENGTH).optional(),
      clientSafeScopeSummary: f.text(MAX_SCOPE_SUMMARY_LENGTH).optional(),
      commitment: commitment().optional(),
      linkedWorkItemId: f.id().optional(),
      deferUntil: day().optional().describe('Deferred only: the day it comes back, YYYY-MM-DD'),
      remindOnReopen: f.bool().optional().describe('Deferred only: remind when it comes back'),
    }),
    redact: 'client_safe',
    notifies: true,
    examples: [
      { summary: 'Start', args: { clientRequestId: 'creq_1', version: 3, to: 'triage' } },
      {
        summary: 'Defer',
        args: { clientRequestId: 'creq_1', version: 4, to: 'deferred', deferUntil: '2027-01-10' },
      },
    ],
  }),
  // A7: "Reopen now" — a deferred request back to triage before its date.
  det({
    id: 'client_requests.reopen.create',
    title: 'Reopen a deferred client request',
    description: 'Bring a deferred client request back to triage now, before its defer date.',
    input: bodyArgs(['clientRequestId'], { version: version() }),
    redact: 'client_safe',
    notifies: true,
    examples: [{ summary: 'Reopen', args: { clientRequestId: 'creq_1', version: 3 } }],
  }),
  // 0212 (audit gap 4): the client <-> studio message thread on a request.
  det({
    id: 'client_requests.messages.list',
    title: 'List client request messages',
    description:
      'The message thread with the client on a request, including team-only messages. ' +
      'Message text is untrusted member content.',
    input: pathOnly('clientRequestId'),
    redact: 'client_safe',
    examples: [{ summary: 'Thread', args: { clientRequestId: 'creq_1' } }],
  }),
  det({
    id: 'client_requests.messages.create',
    title: 'Message the client on a request',
    description:
      'Post a message on a client request. Visible to the client unless clientVisible is false. ' +
      'Confirm-class: a person approves it in TManage before it is sent.',
    input: bodyArgs(['clientRequestId'], {
      body: f.text(5_000),
      clientVisible: f.bool().optional(),
      // A8 (0221): request_message uploads on this request (0232).
      fileIds: f.id().array().max(10).optional(),
    }),
    redact: 'client_safe',
    notifies: true,
    examples: [{ summary: 'Reply', args: { clientRequestId: 'creq_1', body: 'Draft is ready.' } }],
  }),
  det({
    id: 'client_requests.triage.list',
    title: 'Get client request triage',
    description: 'The internal triage of a client request (category, assignee).',
    input: queryArgs(['clientRequestId']),
    redact: 'standard',
    examples: [{ summary: 'Triage', args: { clientRequestId: 'creq_1' } }],
  }),
  det({
    id: 'client_requests.triage.set',
    title: 'Set client request triage',
    description:
      'Set the internal triage of a client request: its category and, optionally, the assigned member (null to clear).',
    input: bodyArgs(['clientRequestId'], {
      category: triageCategory,
      assigneeMembershipId: f.id().nullable().optional(),
    }),
    redact: 'standard',
    examples: [
      {
        summary: 'Prioritise',
        args: { clientRequestId: 'creq_1', category: 'bug', assigneeMembershipId: 'mem_5' },
      },
    ],
  }),
  det({
    id: 'client_requests.aging.list',
    title: 'List aging client requests',
    description: 'Client requests waiting longest, for follow-up.',
    input: listArgs([], {}, { cursor: null }),
    redact: 'standard',
    examples: [{ summary: 'Aging', args: {} }],
  }),
];
