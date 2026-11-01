import { StateMachine, type StateMachineDefinition } from './state-machine.js';

/** `23-ERD-AND-STATE-MACHINES.md` §5. */
export const WORK_ITEM_STATES = [
  'backlog',
  'ready',
  'in_progress',
  'blocked',
  'internal_review',
  'done',
  'archived',
] as const;

export type WorkItemState = (typeof WORK_ITEM_STATES)[number];

/**
 * Whether a raw string — a value read from the `varchar` state column — is one the machine
 * defines. Lets a response projection narrow `string` to {@link WorkItemState} rather than
 * asserting it, so the API cannot type a field as the union while returning a value outside it.
 */
export function isWorkItemState(value: string): value is WorkItemState {
  return (WORK_ITEM_STATES as readonly string[]).includes(value);
}

const definition: StateMachineDefinition<WorkItemState> = {
  name: 'work_item',
  initial: 'backlog',
  states: WORK_ITEM_STATES,
  // 2026-10-31 live test: archive is no longer one-way. An archived item can be restored to the
  // backlog (see the last transition), so the machine has no terminal state.
  terminal: [],
  transitions: [
    { from: 'backlog', to: 'ready' },
    { from: 'backlog', to: 'archived', note: 'Alternate transition, §5.' },
    { from: 'ready', to: 'backlog', note: 'Alternate transition, §5.' },
    { from: 'ready', to: 'in_progress' },
    { from: 'in_progress', to: 'ready', note: 'Alternate transition, §5.' },
    {
      from: 'in_progress',
      to: 'blocked',
      requires: ['blockerReason', 'blockerAsk'],
      accepts: ['blockerOwnerUserId'],
      note: '§5: blocked requires a reason and an ask. US-B04 adds the owner of the ask, optional.',
    },
    {
      from: 'blocked',
      to: 'in_progress',
      requires: ['blockerResolution'],
      note: '§5: leaving blocked resolves the active blocker, recording the outcome.',
    },
    { from: 'in_progress', to: 'internal_review' },
    { from: 'internal_review', to: 'in_progress' },
    {
      from: 'internal_review',
      to: 'done',
      requires: ['ownerId', 'completedAt'],
      note: '§5: done requires an owner and a completion timestamp.',
    },
    {
      from: 'done',
      to: 'in_progress',
      requires: ['reopenReason'],
      note: '§5: reopening a done item requires a recorded reason.',
    },
    { from: 'done', to: 'archived' },
    {
      from: 'archived',
      to: 'backlog',
      note: 'Restore from archive (2026-10-31 live test). The item starts over, not completed.',
    },
  ],
};

export const workItemStateMachine = new StateMachine(definition);
