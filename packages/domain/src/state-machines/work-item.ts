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

const definition: StateMachineDefinition<WorkItemState> = {
  name: 'work_item',
  initial: 'backlog',
  states: WORK_ITEM_STATES,
  terminal: ['archived'],
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
      note: '§5: blocked requires a reason and an ask. US-B04 adds the owner of the ask.',
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
  ],
};

export const workItemStateMachine = new StateMachine(definition);
