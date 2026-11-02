/**
 * 53-07 — milestones and phases on the timeline. Pure: no I/O, no clock read (the caller passes
 * `today`), no framework.
 *
 * - A **phase band** is the date span a phase covers on the Gantt: its explicit `startsOn`/`endsOn`
 *   when set, else the earliest and latest marker date of the milestones assigned to it, else none.
 * - A **milestone marker** (the diamond) sits on `committedOn ?? forecastOn ?? dueOn`. Its `health`
 *   is read from the dates only: 'done' once met, 'at_risk' when the forecast lands after the
 *   committed date or the committed date has passed without the milestone being met, else 'on_track'.
 * - `clientStatusOf` is the client-safe status the published copy carries — the same three words,
 *   never the internal forecast that produced them.
 *
 * Every date is a civil `YYYY-MM-DD` string, so plain string comparison orders them.
 */

export type MilestoneHealth = 'done' | 'on_track' | 'at_risk';

/** The client-safe status of a published milestone. */
export type ClientMilestoneStatus = MilestoneHealth;

export interface TimelinePhaseInput {
  readonly id: string;
  readonly name: string;
  readonly position: number;
  readonly startsOn: string | null;
  readonly endsOn: string | null;
  readonly colorToken: string | null;
}

export interface TimelineMilestoneInput {
  readonly id: string;
  readonly title: string;
  /** `planned | met | missed` (0048). */
  readonly status: string;
  readonly dueOn: string | null;
  readonly committedOn: string | null;
  readonly forecastOn: string | null;
  readonly timelineOrder: number | null;
  /** The phase this milestone is assigned to, or null. */
  readonly phaseId: string | null;
}

export interface PhaseBand {
  readonly id: string;
  readonly name: string;
  readonly position: number;
  readonly startsOn: string | null;
  readonly endsOn: string | null;
  readonly colorToken: string | null;
  /** 'explicit' when both ends were set on the phase, 'derived' from its milestones, else 'none'. */
  readonly source: 'explicit' | 'derived' | 'none';
}

export interface MilestoneMarker {
  readonly id: string;
  /** The diamond's day: committed, else forecast, else due; null when undated. */
  readonly date: string | null;
  readonly health: MilestoneHealth;
}

/** The diamond's day: `committedOn ?? forecastOn ?? dueOn`. */
export function markerDateOf(milestone: TimelineMilestoneInput): string | null {
  return milestone.committedOn ?? milestone.forecastOn ?? milestone.dueOn ?? null;
}

/** Done, on track or at risk — from the dates and the met status only. */
export function milestoneHealthOf(
  milestone: TimelineMilestoneInput,
  today: string,
): MilestoneHealth {
  if (milestone.status === 'met') return 'done';
  if (milestone.status === 'missed') return 'at_risk';
  const committed = milestone.committedOn;
  if (committed !== null) {
    if (milestone.forecastOn !== null && milestone.forecastOn > committed) return 'at_risk';
    if (committed < today) return 'at_risk';
  }
  return 'on_track';
}

/** The client-safe status a published copy carries. */
export function clientStatusOf(
  milestone: TimelineMilestoneInput,
  today: string,
): ClientMilestoneStatus {
  return milestoneHealthOf(milestone, today);
}

/** One marker per milestone, in the order given. */
export function milestoneMarkers(
  milestones: readonly TimelineMilestoneInput[],
  today: string,
): readonly MilestoneMarker[] {
  return milestones.map((milestone) => ({
    id: milestone.id,
    date: markerDateOf(milestone),
    health: milestoneHealthOf(milestone, today),
  }));
}

/**
 * Timeline order: an explicit `timelineOrder` first (ascending), then the marker date (undated
 * last), then the title, then the id so the order is total.
 */
export function orderMilestones<T extends TimelineMilestoneInput>(rows: readonly T[]): T[] {
  return [...rows].sort((left, right) => {
    const lo = left.timelineOrder;
    const ro = right.timelineOrder;
    if (lo !== ro) {
      if (lo === null) return 1;
      if (ro === null) return -1;
      return lo - ro;
    }
    const ld = markerDateOf(left);
    const rd = markerDateOf(right);
    if (ld !== rd) {
      if (ld === null) return 1;
      if (rd === null) return -1;
      return ld < rd ? -1 : 1;
    }
    if (left.title !== right.title) return left.title < right.title ? -1 : 1;
    return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
  });
}

/**
 * One band per phase, in `position` order. Explicit dates win when both are set; otherwise the
 * span runs from the earliest to the latest marker date of the milestones assigned to the phase
 * (an explicit end alone still caps the derived start, and vice versa); a phase with neither has
 * no band.
 */
export function phaseBands(
  phases: readonly TimelinePhaseInput[],
  milestones: readonly TimelineMilestoneInput[],
): readonly PhaseBand[] {
  const ordered = [...phases].sort(
    (left, right) => left.position - right.position || (left.id < right.id ? -1 : 1),
  );
  return ordered.map((phase) => {
    const base = {
      id: phase.id,
      name: phase.name,
      position: phase.position,
      colorToken: phase.colorToken,
    };
    if (phase.startsOn !== null && phase.endsOn !== null) {
      return { ...base, startsOn: phase.startsOn, endsOn: phase.endsOn, source: 'explicit' };
    }
    const dates = milestones
      .filter((milestone) => milestone.phaseId === phase.id)
      .map(markerDateOf)
      .filter((date): date is string => date !== null)
      .sort();
    const startsOn = phase.startsOn ?? dates[0] ?? null;
    const endsOn = phase.endsOn ?? dates[dates.length - 1] ?? null;
    if (startsOn === null && endsOn === null) {
      return { ...base, startsOn: null, endsOn: null, source: 'none' };
    }
    return { ...base, startsOn, endsOn, source: 'derived' };
  });
}
