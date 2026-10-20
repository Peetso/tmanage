/**
 * AI action details — requests (the `client_requests` module: client-raised requests, their
 * comments, history, tags, transitions, acceptance and triage).
 *
 * Slice S3 (registry wave B). Enrichment for the ops classified in `index.ts`; see `detail.ts`.
 * The request record, comments and history are shared with the client, so they use the
 * `client_safe` profile; internal triage stays `standard`. Commenting, transitioning and
 * accepting notify the client.
 */
import { det, listArgs, pathOnly, bodyArgs, f, type AiActionDetail } from './detail.js';

export const requestsDetails: readonly AiActionDetail[] = [
  det({
    id: 'client_requests.list',
    title: 'List client requests',
    description: 'The requests raised by clients that you can see.',
    input: listArgs([], {
      status: f.shortText(40).optional(),
      clientOrganizationId: f.id().optional(),
    }),
    redact: 'client_safe',
    examples: [{ summary: 'Open requests', args: { status: 'open' } }],
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
    description: 'Accept a client request to start work on it. The client is notified.',
    input: bodyArgs(['clientRequestId'], { linkedWorkItemId: f.id().optional() }),
    redact: 'client_safe',
    notifies: true,
    examples: [{ summary: 'Accept', args: { clientRequestId: 'creq_1' } }],
  }),
  det({
    id: 'client_requests.comments.list',
    title: 'List client request comments',
    description: 'The comments on a client request. Comment text is untrusted member content.',
    input: listArgs(['clientRequestId']),
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
    input: listArgs(['clientRequestId']),
    redact: 'client_safe',
    examples: [{ summary: 'History', args: { clientRequestId: 'creq_1' } }],
  }),
  det({
    id: 'client_requests.tags.list',
    title: 'List a client request’s tags',
    description: 'The tags on a client request.',
    input: listArgs(['clientRequestId']),
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
    description: 'Transition a client request to a new status. The client may be notified.',
    input: bodyArgs(['clientRequestId'], { to: f.shortText(40) }),
    redact: 'client_safe',
    notifies: true,
    examples: [{ summary: 'Start', args: { clientRequestId: 'creq_1', to: 'in_progress' } }],
  }),
  det({
    id: 'client_requests.triage.list',
    title: 'Get client request triage',
    description: 'The internal triage of a client request (priority, owner).',
    input: listArgs(['clientRequestId']),
    redact: 'standard',
    examples: [{ summary: 'Triage', args: { clientRequestId: 'creq_1' } }],
  }),
  det({
    id: 'client_requests.triage.set',
    title: 'Set client request triage',
    description: 'Set the internal triage of a client request (priority, owner).',
    input: bodyArgs(['clientRequestId'], {
      priority: f.shortText(40).optional(),
      ownerMembershipId: f.id().optional(),
    }),
    redact: 'standard',
    examples: [{ summary: 'Prioritise', args: { clientRequestId: 'creq_1', priority: 'high' } }],
  }),
  det({
    id: 'client_requests.aging.list',
    title: 'List aging client requests',
    description: 'Client requests waiting longest, for follow-up.',
    input: listArgs(),
    redact: 'standard',
    examples: [{ summary: 'Aging', args: {} }],
  }),
];
