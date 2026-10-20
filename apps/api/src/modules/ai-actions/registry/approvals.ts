/**
 * AI action details — approvals (internal approval workflow and client-facing deliverable
 * projections/decisions).
 *
 * Slice S3 (registry wave B). Enrichment for the ops classified in `index.ts`; see `detail.ts`.
 * Deciding, delegating, adding steps and publishing a projection are confirm-class and notify
 * people. Client-facing projection ops use the `client_safe` profile: the published projection is
 * the 12-PERMISSION-MATRIX §1 allowlist only (title, summary, milestoneState, forecastDate,
 * publishedRisk, decision, approvedContacts — see `approvals.controller.ts`), never internal
 * cost/estimate/review/rationale fields.
 */
import { z } from 'zod';
import { det, listArgs, pathOnly, bodyArgs, f, type AiActionDetail } from './detail.js';

/** The reviewer decision enum mirrored from `approvals.controller.ts`. */
const decision = z.enum(['approve', 'request_changes']);

/** The client-safe projection payload (allowlist only; the controller rejects any other key). */
const projection = z
  .object({
    title: f.shortText(300),
    summary: f.text(5_000).nullish(),
    milestoneState: f.shortText(120).nullish(),
    forecastDate: f.iso().nullish(),
    publishedRisk: f.shortText(120).nullish(),
    decision: f.shortText(40).nullish(),
    approvedContacts: z.array(f.shortText(200)).max(100).optional(),
  })
  .strict();

export const approvalsDetails: readonly AiActionDetail[] = [
  det({
    id: 'approvals.create',
    title: 'Open an approval',
    description:
      'Open an approval on a deliverable version and request reviewers. Reviewers are notified.',
    input: bodyArgs([], {
      deliverableVersionId: f.id(),
      reviewerIds: z.array(f.id()).min(1).max(50),
      policy: f.shortText(40).optional(),
    }),
    redact: 'standard',
    notifies: true,
    examples: [
      {
        summary: 'Request review',
        args: { deliverableVersionId: 'dv_1', reviewerIds: ['user_3'] },
      },
    ],
  }),
  det({
    id: 'approvals.decision.create',
    title: 'Decide an approval',
    description:
      'Approve or request changes on an approval. Confirm-class; the requester is notified.',
    input: bodyArgs(['approvalId'], { decision, feedback: f.text(5_000).optional() }),
    redact: 'standard',
    notifies: true,
    examples: [{ summary: 'Approve', args: { approvalId: 'appr_1', decision: 'approve' } }],
  }),
  det({
    id: 'approvals.steps.list',
    title: 'List approval steps',
    description: 'The review steps of an approval.',
    input: listArgs(['approvalId']),
    redact: 'standard',
    examples: [{ summary: 'Steps', args: { approvalId: 'appr_1' } }],
  }),
  det({
    id: 'approvals.steps.create',
    title: 'Add an approval step',
    description: 'Add a review step to an approval. Confirm-class; reviewers are notified.',
    input: bodyArgs(['approvalId'], { reviewerIds: z.array(f.id()).min(1).max(50).optional() }),
    redact: 'standard',
    notifies: true,
    examples: [{ summary: 'Add step', args: { approvalId: 'appr_1', reviewerIds: ['user_4'] } }],
  }),
  det({
    id: 'approvals.steps.set',
    title: 'Decide an approval step',
    description: 'Record a decision on one approval step. Confirm-class.',
    input: bodyArgs(['approvalId', 'stepId'], { decision }),
    redact: 'standard',
    examples: [
      {
        summary: 'Approve step',
        args: { approvalId: 'appr_1', stepId: 'step_2', decision: 'approve' },
      },
    ],
  }),
  det({
    id: 'approvals.delegations.list',
    title: 'List approval delegations',
    description: 'Who approvals are delegated to, and when.',
    input: listArgs(),
    redact: 'standard',
    examples: [{ summary: 'Delegations', args: {} }],
  }),
  det({
    id: 'approvals.delegations.create',
    title: 'Delegate approvals',
    description:
      'Delegate your approvals to another member for a period. Confirm-class; they are notified.',
    input: bodyArgs([], {
      delegateMembershipId: f.id(),
      startsAt: f.iso().optional(),
      endsAt: f.iso().optional(),
    }),
    redact: 'standard',
    notifies: true,
    examples: [{ summary: 'Delegate', args: { delegateMembershipId: 'mem_5' } }],
  }),
  det({
    id: 'approvals.delegations.delete',
    title: 'Remove an approval delegation',
    description: 'Cancel an approval delegation. Confirm-class.',
    input: pathOnly('delegationId'),
    redact: 'standard',
    examples: [{ summary: 'Cancel', args: { delegationId: 'del_1' } }],
  }),
  det({
    id: 'approvals.projections.create',
    title: 'Publish a client projection',
    description:
      'Freeze and publish the client-safe projection of a deliverable version. Confirm-class; ' +
      'client-visible, so only the allowlisted fields are stored.',
    input: bodyArgs([], { deliverableVersionId: f.id(), projection }),
    redact: 'client_safe',
    notifies: true,
    examples: [
      {
        summary: 'Publish',
        args: { deliverableVersionId: 'dv_1', projection: { title: 'Logo pack v2' } },
      },
    ],
  }),
  det({
    id: 'approvals.projections.get',
    title: 'Get a client projection',
    description: 'Read the published client-safe projection for a deliverable version.',
    input: pathOnly('deliverableVersionId'),
    redact: 'client_safe',
    examples: [{ summary: 'By version', args: { deliverableVersionId: 'dv_1' } }],
  }),
  det({
    id: 'approvals.projections.decision.create',
    title: 'Record a client projection decision',
    description:
      'Record the client’s approve/request-changes decision on a published projection. Confirm-class.',
    input: bodyArgs(['deliverableVersionId'], {
      decision,
      feedback: f.text(5_000).optional(),
      version: f.int(1, 100_000).optional(),
    }),
    redact: 'client_safe',
    notifies: true,
    examples: [
      { summary: 'Client approves', args: { deliverableVersionId: 'dv_1', decision: 'approve' } },
    ],
  }),
];
