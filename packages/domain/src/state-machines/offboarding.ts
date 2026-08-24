import { StateMachine, type StateMachineDefinition } from './state-machine.js';

/** `23-ERD-AND-STATE-MACHINES.md` §11. */
export const OFFBOARDING_STATES = [
  'previewed',
  'confirmed',
  'suspending',
  'transferring',
  'reviewing_external_access',
  'completed',
  'failed_partial',
] as const;

export type OffboardingState = (typeof OFFBOARDING_STATES)[number];

const definition: StateMachineDefinition<OffboardingState> = {
  name: 'offboarding',
  initial: 'previewed',
  states: OFFBOARDING_STATES,
  terminal: ['completed', 'failed_partial'],
  transitions: [
    { from: 'previewed', to: 'confirmed', requires: ['confirmedByUserId'] },
    {
      from: 'confirmed',
      to: 'suspending',
      note:
        '§11 + US-A03: session and credential revocation happens at the START of suspending, ' +
        'before any transfer work begins.',
    },
    { from: 'suspending', to: 'transferring', requires: ['sessionsRevokedAt'] },
    { from: 'suspending', to: 'failed_partial', requires: ['failureCode'] },
    { from: 'transferring', to: 'reviewing_external_access' },
    { from: 'transferring', to: 'failed_partial', requires: ['failureCode'] },
    {
      from: 'reviewing_external_access',
      to: 'completed',
      requires: ['completionReceiptId'],
      note: 'US-A03: a completion receipt and audit record close the process.',
    },
    { from: 'reviewing_external_access', to: 'failed_partial', requires: ['failureCode'] },
  ],
};

export const offboardingStateMachine = new StateMachine(definition);

/**
 * `failed_partial` is terminal on purpose.
 *
 * `23-ERD §11`: partial failure keeps the membership suspended and creates admin retry
 * tasks. It never restores access automatically, so there is deliberately no transition
 * out of it back into the flow — a retry is a new offboarding run against a membership
 * that is already suspended.
 */
export const OFFBOARDING_NEVER_AUTO_RESTORES_ACCESS = true;
