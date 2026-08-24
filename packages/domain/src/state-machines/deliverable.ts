import { StateMachine, type StateMachineDefinition } from './state-machine.js';

/** `23-ERD-AND-STATE-MACHINES.md` §7. */
export const DELIVERABLE_STATES = [
  'draft',
  'internal_review',
  'ready_for_client',
  'client_review',
  'changes_requested',
  'approved',
  'final',
  'archived',
] as const;

export type DeliverableState = (typeof DELIVERABLE_STATES)[number];

const definition: StateMachineDefinition<DeliverableState> = {
  name: 'deliverable',
  initial: 'draft',
  states: DELIVERABLE_STATES,
  terminal: ['archived'],
  transitions: [
    { from: 'draft', to: 'internal_review', requires: ['deliverableVersionId'] },
    { from: 'internal_review', to: 'draft' },
    {
      from: 'internal_review',
      to: 'ready_for_client',
      requires: ['internalReviewerUserId', 'internalReviewedAt'],
      note: 'FR-04: an internal reviewer approves readiness before anything reaches a client.',
    },
    {
      from: 'ready_for_client',
      to: 'client_review',
      requires: ['clientProjectionId', 'reviewerIds'],
      note:
        'FR-04 + US-C02: publication creates the immutable client projection. The deliverable ' +
        'does not enter client review without one.',
    },
    { from: 'ready_for_client', to: 'internal_review' },
    { from: 'client_review', to: 'changes_requested', requires: ['feedback'] },
    { from: 'changes_requested', to: 'draft' },
    { from: 'changes_requested', to: 'internal_review' },
    {
      from: 'client_review',
      to: 'approved',
      requires: ['approvalId', 'approvedVersionId', 'contentHash'],
      note: '§7: approved is derived from approval policy, bound to the exact version and hash.',
    },
    {
      from: 'client_review',
      to: 'internal_review',
      note:
        '§7 + FR-05: a governed content change during client review returns the deliverable to ' +
        'internal review and invalidates the pending approval.',
    },
    {
      from: 'approved',
      to: 'final',
      requires: ['finalizedByUserId', 'finalizedAt'],
      note: 'US-C04: finalisation from an approved version.',
    },
    {
      from: 'ready_for_client',
      to: 'final',
      requires: ['finalizedByUserId', 'finalizedAt', 'waiverReason', 'waiverAuthorizedByUserId'],
      note:
        '§7 + US-C04: final requires an approved version OR an authorized waiver with a ' +
        'rationale. The waiver path is separate and demands both the reason and who authorized it.',
    },
    { from: 'final', to: 'archived' },
    { from: 'draft', to: 'archived' },
  ],
};

export const deliverableStateMachine = new StateMachine(definition);

/**
 * States in which the deliverable has content exposed to a client organization.
 *
 * Used by the publication safety scanner and by the invalidation rule: a governed change
 * while in one of these states has external consequences and cannot be applied silently.
 */
export const CLIENT_EXPOSED_DELIVERABLE_STATES: readonly DeliverableState[] = [
  'client_review',
  'changes_requested',
  'approved',
  'final',
];
