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

/*
 * FIX3 item 4 (live check a6f66e47 T1): a finished tour came back. The outcome is now also kept on
 * this device, so a tour that ended never opens again here even if the save did not reach the
 * server; the screen sends the save again when the server still says "not seen".
 */
const deviceKey = (organizationSlug: string, tour: CoachMarkTour | 'never') =>
  `tm-coach:${organizationSlug}:${tour}`;

function deviceStorage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

/** How this tour ended on this device, if it did. */
export function rememberedTourOutcome(
  organizationSlug: string,
  tour: CoachMarkTour,
): CoachMarkOutcome | null {
  try {
    const value = deviceStorage()?.getItem(deviceKey(organizationSlug, tour));
    return value === 'done' || value === 'skipped' ? value : null;
  } catch {
    return null;
  }
}

/** Whether "Don't show tours again" was chosen on this device. */
export function rememberedNeverAgain(organizationSlug: string): boolean {
  try {
    return deviceStorage()?.getItem(deviceKey(organizationSlug, 'never')) === 'true';
  } catch {
    return false;
  }
}

/** Keep a tour's ending (and the "never again" choice) on this device. */
export function rememberTourOutcome(
  organizationSlug: string,
  tour: CoachMarkTour,
  outcome: CoachMarkOutcome,
  neverAgain: boolean,
): void {
  try {
    const storage = deviceStorage();
    storage?.setItem(deviceKey(organizationSlug, tour), outcome);
    if (neverAgain) storage?.setItem(deviceKey(organizationSlug, 'never'), 'true');
  } catch {
    // Remembering on the device is a backstop; a refusing store must never break the screen.
  }
}
