import { StateMachine, type StateMachineDefinition } from '../../state-machines/state-machine.js';

/**
 * 60-01 (plan 60 v2 §2.10, §4.2 M2, §4.5 "revoke paths"). The status of an AI employee.
 *
 * `active` works; `paused` keeps everything but every agent call is refused; `retired` is the end:
 * credentials die, open assignments go back to their supervisors, the member row stays (never
 * deleted) so its history keeps its author. The legal moves are data (DM-8).
 */
export const AI_EMPLOYEE_STATUSES = ['active', 'paused', 'retired'] as const;

export type AiEmployeeStatus = (typeof AI_EMPLOYEE_STATUSES)[number];

/**
 * Why an AI employee is paused. `manual`: a person pressed Pause. The others are set by the server
 * (§2.10, §4.9): the sponsor left the company, three limit days in a row, five refused
 * out-of-contract calls in an hour, ten failed submissions in a day.
 */
export const AI_EMPLOYEE_PAUSE_REASONS = [
  'manual',
  'sponsor_left',
  'limit_days',
  'out_of_contract_calls',
  'failed_submissions',
] as const;

export type AiEmployeePauseReason = (typeof AI_EMPLOYEE_PAUSE_REASONS)[number];

const definition: StateMachineDefinition<AiEmployeeStatus> = {
  name: 'ai_employee',
  initial: 'active',
  states: AI_EMPLOYEE_STATUSES,
  terminal: ['retired'],
  transitions: [
    { from: 'active', to: 'paused', requires: ['pausedReason'] },
    {
      from: 'paused',
      to: 'active',
      requires: ['activeSponsor'],
      note: '§2.10: a paused AI employee resumes only with a sponsor who is an active person.',
    },
    { from: 'active', to: 'retired', requires: ['retiredByMembershipId'] },
    { from: 'paused', to: 'retired', requires: ['retiredByMembershipId'] },
  ],
};

export const aiEmployeeStateMachine = new StateMachine(definition);

export function parseAiEmployeeStatus(value: unknown): AiEmployeeStatus | null {
  return AI_EMPLOYEE_STATUSES.find((status) => status === value) ?? null;
}

export function parseAiEmployeePauseReason(value: unknown): AiEmployeePauseReason | null {
  return AI_EMPLOYEE_PAUSE_REASONS.find((reason) => reason === value) ?? null;
}

/**
 * May the agent's credential be used at all (§4.6 step 1, the employee half)? Only `active`.
 * The platform and workspace switches, limits and hours are checked beside it (60-06, 60-34).
 */
export function aiEmployeeMayWork(status: AiEmployeeStatus): boolean {
  return status === 'active';
}
