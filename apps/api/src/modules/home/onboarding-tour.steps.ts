import { ONBOARDING_TOUR_STEPS } from '../../common/database/schema.js';
import type { OnboardingTourStep } from '../../common/database/schema.js';

/**
 * ON-10 guided tour — the fixed, ordered step list.
 *
 * The identifiers are the schema ENUM's (`ONBOARDING_TOUR_STEPS`), re-exported here so the controller
 * and the response projection share one source of truth with the column: a value outside this set is
 * a 400 in the route and a write error at the engine, so an unknown step can never be stored. The
 * order here is the order the tour is presented in, and the label is the human name a screen renders;
 * neither is stored — only which steps a member has completed is (`onboarding_progress`).
 */
export interface OnboardingTourStepDef {
  readonly step: OnboardingTourStep;
  readonly label: string;
}

/** The fixed tour, in presentation order. Adding a step means adding it to the schema ENUM too. */
export const ONBOARDING_TOUR: readonly OnboardingTourStepDef[] = [
  { step: 'welcome', label: 'Take a look around' },
  { step: 'create_project', label: 'Create your first project' },
  { step: 'invite_team', label: 'Invite your team' },
  { step: 'explore_work', label: 'Explore the work board' },
  { step: 'share_portal', label: 'Share a client portal' },
];

/** Type guard: whether an unknown value is one of the fixed tour steps. */
export function isOnboardingTourStep(value: unknown): value is OnboardingTourStep {
  return typeof value === 'string' && (ONBOARDING_TOUR_STEPS as readonly string[]).includes(value);
}
