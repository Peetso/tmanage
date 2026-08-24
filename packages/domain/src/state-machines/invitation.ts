import { StateMachine, type StateMachineDefinition } from './state-machine.js';

/** `23-ERD-AND-STATE-MACHINES.md` §9. */
export const INVITATION_STATES = ['pending', 'accepted', 'expired', 'revoked'] as const;

export type InvitationState = (typeof INVITATION_STATES)[number];

const definition: StateMachineDefinition<InvitationState> = {
  name: 'invitation',
  initial: 'pending',
  states: INVITATION_STATES,
  terminal: ['accepted', 'expired', 'revoked'],
  transitions: [
    {
      from: 'pending',
      to: 'accepted',
      requires: ['acceptedByUserId', 'acceptedAt'],
      note: '§9: tokens are single-use. Acceptance is terminal.',
    },
    { from: 'pending', to: 'expired' },
    { from: 'pending', to: 'revoked', requires: ['revokedByUserId'] },
  ],
};

export const invitationStateMachine = new StateMachine(definition);
