/**
 * 55-01 / 55-01a / 55-03 — the three-minute onboarding wizard's step state.
 *
 * Pure functions only: the wizard's progress for one organization is a small value stored as the
 * `onboarding_wizard` row of `org_settings` (no new table — the key/value settings row fits, and
 * the canonical string below stays far under its VARCHAR(255)). This module is the single source of
 * the step list, the canonical string form, and the resume rule, so the controller and its tests
 * share one definition.
 *
 * ## Canonical form
 *
 * `v1;<status>;<step>=<d|s>,…` — the version tag, the wizard status, then each step that has an
 * outcome (`d` done, `s` skipped) in wizard order. An empty outcome list is `v1;active;`. Anything
 * that does not parse reads as a fresh wizard: a damaged row never blocks a new company.
 */

/** The wizard's steps, in the order the screen presents them. */
export const WIZARD_STEPS = [
  'company',
  'work_type',
  'invite',
  'storage',
  'sample_project',
  'finish',
] as const;
export type WizardStep = (typeof WIZARD_STEPS)[number];

export const WIZARD_OUTCOMES = ['done', 'skipped'] as const;
export type WizardOutcome = (typeof WIZARD_OUTCOMES)[number];

/** `active` while in progress; `completed` after Finish; `dismissed` after "Skip setup". */
export const WIZARD_STATUSES = ['active', 'completed', 'dismissed'] as const;
export type WizardStatus = (typeof WIZARD_STATUSES)[number];

export interface WizardState {
  readonly status: WizardStatus;
  readonly outcomes: Readonly<Partial<Record<WizardStep, WizardOutcome>>>;
}

const VERSION = 'v1';
const OUTCOME_CODE: Readonly<Record<WizardOutcome, string>> = { done: 'd', skipped: 's' };

export function isWizardStep(value: unknown): value is WizardStep {
  return typeof value === 'string' && (WIZARD_STEPS as readonly string[]).includes(value);
}

export function isWizardOutcome(value: unknown): value is WizardOutcome {
  return typeof value === 'string' && (WIZARD_OUTCOMES as readonly string[]).includes(value);
}

/** A wizard nobody has started. */
export function emptyWizardState(): WizardState {
  return { status: 'active', outcomes: {} };
}

/** The canonical string stored in `org_settings`. */
export function serializeWizardState(state: WizardState): string {
  const parts = WIZARD_STEPS.flatMap((step) => {
    const outcome = state.outcomes[step];
    return outcome ? [`${step}=${OUTCOME_CODE[outcome]}`] : [];
  });
  return `${VERSION};${state.status};${parts.join(',')}`;
}

/** Strictly parse a stored value; `undefined` when it is not a canonical wizard state. */
function parseStrict(raw: string): WizardState | undefined {
  const [version, status, list, ...rest] = raw.trim().split(';');
  if (version !== VERSION || rest.length > 0 || list === undefined) return undefined;
  if (!(WIZARD_STATUSES as readonly string[]).includes(status ?? '')) return undefined;
  const outcomes: Partial<Record<WizardStep, WizardOutcome>> = {};
  for (const entry of list === '' ? [] : list.split(',')) {
    const [step, code] = entry.split('=');
    if (!isWizardStep(step) || outcomes[step] !== undefined) return undefined;
    if (code === 'd') outcomes[step] = 'done';
    else if (code === 's') outcomes[step] = 'skipped';
    else return undefined;
  }
  return { status: status as WizardStatus, outcomes };
}

/** Read a stored value; a missing or damaged row is a fresh wizard. */
export function parseWizardState(stored: string | undefined): WizardState {
  return (stored !== undefined && parseStrict(stored)) || emptyWizardState();
}

/** The `org_settings` validator: canonical value or a rejection message. */
export function validateWizardStateValue(
  raw: string,
):
  { readonly ok: true; readonly value: string } | { readonly ok: false; readonly message: string } {
  const state = parseStrict(raw);
  return state
    ? { ok: true, value: serializeWizardState(state) }
    : { ok: false, message: 'That is not a wizard state.' };
}

/**
 * Where the wizard resumes: the first step with no outcome yet, or `finish` once every earlier
 * step has one. Status does not change the answer, so a dismissed wizard reopened from Settings
 * picks up where it was left.
 */
export function resumeStep(state: WizardState): WizardStep {
  return WIZARD_STEPS.find((step) => state.outcomes[step] === undefined) ?? 'finish';
}

/**
 * Record a step's outcome. Finish cannot be skipped and completes the wizard; any other step
 * reopens a dismissed wizard as active. Re-recording a step overwrites it (the Back button).
 */
export function recordStep(
  state: WizardState,
  step: WizardStep,
  outcome: WizardOutcome,
): WizardState | { readonly error: 'finish_cannot_be_skipped' } {
  if (step === 'finish') {
    if (outcome !== 'done') return { error: 'finish_cannot_be_skipped' };
    return { status: 'completed', outcomes: { ...state.outcomes, finish: 'done' } };
  }
  const status: WizardStatus = state.status === 'completed' ? 'completed' : 'active';
  return { status, outcomes: { ...state.outcomes, [step]: outcome } };
}

/** "Skip setup": leave the wizard. Keeps the outcomes so a later visit resumes in place. */
export function dismissWizard(state: WizardState): WizardState {
  return state.status === 'completed' ? state : { ...state, status: 'dismissed' };
}
