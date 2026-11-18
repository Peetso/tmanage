import { queryOptions } from '@tanstack/react-query';
import type { ApiClient } from '../../lib/api/client';
import {
  getCoachMarks,
  rememberedNeverAgain,
  rememberedTourOutcome,
  shouldShowTour,
} from '../../lib/api/coach-marks';
import type { CoachMarksView, CoachMarkTour } from '../../lib/api/coach-marks';

/** The cache key of the member's own tour state; every screen's tour reads and writes it. */
export function coachMarksKey(organizationSlug: string) {
  return ['coach-marks', organizationSlug] as const;
}

/**
 * The member's tour state. The tours draw from it, and Home's automatic timer reads the same
 * entry so it does not open its own first-visit panel over the Home tour.
 */
export function coachMarksQuery(api: ApiClient, organizationSlug: string) {
  return queryOptions({
    queryKey: coachMarksKey(organizationSlug),
    queryFn: () => getCoachMarks(api, organizationSlug),
  });
}

/**
 * Whether `tour` opens on this device: the server has never seen it end, it did not end here
 * either, and tours were not turned off here (FIX3 item 4).
 */
export function tourOpensHere(
  view: CoachMarksView | undefined,
  organizationSlug: string,
  tour: CoachMarkTour,
): boolean {
  return (
    rememberedTourOutcome(organizationSlug, tour) === null &&
    !rememberedNeverAgain(organizationSlug) &&
    shouldShowTour(view, tour)
  );
}
