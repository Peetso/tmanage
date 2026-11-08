import type { ApiClient } from './client';

/** Row 55-09 — the three first-visit tours. Mirrors the API's `COACH_MARK_TOURS`. */
export const COACH_MARK_TOURS = ['my_day', 'projects', 'work_board'] as const;
export type CoachMarkTour = (typeof COACH_MARK_TOURS)[number];
export type CoachMarkOutcome = 'done' | 'skipped';

/** The caller's own tour state, kept under `coachMarks` in their preferences. */
export interface CoachMarksView {
  readonly tours: Readonly<Record<CoachMarkTour, CoachMarkOutcome | null>>;
  readonly neverAgain: boolean;
}

/** A change: how one tour ended, and/or the "don't show tours again" choice. */
export interface CoachMarksPatch {
  readonly tour?: CoachMarkTour;
  readonly outcome?: CoachMarkOutcome;
  readonly neverAgain?: boolean;
}

const path = (organizationSlug: string) =>
  `/v1/organizations/${encodeURIComponent(organizationSlug)}/me/coach-marks`;

export async function getCoachMarks(
  client: ApiClient,
  organizationSlug: string,
): Promise<CoachMarksView> {
  const { data } = await client.request<CoachMarksView>({ path: path(organizationSlug) });
  return data;
}

export async function saveCoachMarks(
  client: ApiClient,
  organizationSlug: string,
  patch: CoachMarksPatch,
): Promise<CoachMarksView> {
  const { data } = await client.request<CoachMarksView>({
    method: 'PUT',
    path: path(organizationSlug),
    body: patch,
  });
  return data;
}

/** Whether a tour should open: never ended before, and tours not turned off. */
export function shouldShowTour(view: CoachMarksView | undefined, tour: CoachMarkTour): boolean {
  // A malformed answer (an older API, a proxy page) never opens a tour and never breaks the screen.
  if (typeof view?.tours !== 'object' || view.tours === null) return false;
  return view.neverAgain !== true && view.tours[tour] === null;
}
