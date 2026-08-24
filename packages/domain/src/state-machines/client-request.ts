import { StateMachine, type StateMachineDefinition } from './state-machine.js';

/** `23-ERD-AND-STATE-MACHINES.md` §6. */
export const CLIENT_REQUEST_STATES = [
  'submitted',
  'triage',
  'needs_clarification',
  'accepted',
  'deferred',
  'declined',
  'planned',
  'delivered',
  'withdrawn',
] as const;

export type ClientRequestState = (typeof CLIENT_REQUEST_STATES)[number];

const definition: StateMachineDefinition<ClientRequestState> = {
  name: 'client_request',
  initial: 'submitted',
  states: CLIENT_REQUEST_STATES,
  terminal: ['declined', 'delivered', 'withdrawn'],
  transitions: [
    { from: 'submitted', to: 'triage' },
    {
      from: 'submitted',
      to: 'withdrawn',
      note: '§6: the client may withdraw before delivery.',
    },
    {
      from: 'triage',
      to: 'needs_clarification',
      requires: ['clarificationQuestion'],
      note: 'FR-01: the clarification the client is being asked for must be stated.',
    },
    { from: 'needs_clarification', to: 'triage' },
    { from: 'needs_clarification', to: 'withdrawn' },
    {
      from: 'triage',
      to: 'accepted',
      requires: ['clientSafeScopeSummary', 'commitment', 'linkedWorkItemId'],
      note:
        '§6 + FR-01: acceptance requires a client-safe scope summary, a committed date or an ' +
        'explicit unscheduled state, and linked committed work. `commitment` carries one or the other.',
    },
    {
      from: 'triage',
      to: 'deferred',
      requires: ['clientVisibleReason'],
      note: 'US-B02: deferral requires a client-safe reason.',
    },
    {
      from: 'triage',
      to: 'declined',
      requires: ['clientVisibleReason'],
      note: 'US-B02: decline requires a client-safe reason.',
    },
    { from: 'accepted', to: 'planned' },
    { from: 'planned', to: 'delivered' },
  ],
};

export const clientRequestStateMachine = new StateMachine(definition);

/**
 * Transitions only an internal manager may perform.
 *
 * `23-ERD §6`: "Only internal manager may accept/defer/decline." This list is consumed by
 * the authorization policy; it is expressed here so the rule sits next to the machine it
 * constrains rather than being reinvented in the API layer.
 */
export const MANAGER_ONLY_CLIENT_REQUEST_TRANSITIONS: readonly ClientRequestState[] = [
  'triage',
  'needs_clarification',
  'accepted',
  'deferred',
  'declined',
  'planned',
  'delivered',
];

/** The only transition a client principal may perform on their own request. */
export const CLIENT_ALLOWED_CLIENT_REQUEST_TRANSITIONS: readonly ClientRequestState[] = [
  'withdrawn',
];
