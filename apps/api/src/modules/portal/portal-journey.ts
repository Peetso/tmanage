import type { ClientProjectionRow, ProjectMilestoneRow } from '../../common/database/schema.js';

/**
 * 52-27 — the client journey stepper, derived. No table of its own: the steps are the milestones
 * the studio published, the client's turn is the oldest published deliverable version still
 * waiting on the client's decision. Pure, so the state rules are unit-proven without a database.
 */

/** Where one step sits on the client's path. */
export type PortalJourneyStepState = 'done' | 'now' | 'next';

export interface PortalJourneyStep {
  readonly id: string;
  /** The client-safe name (53-07 `client_title`), falling back to the milestone title. */
  readonly title: string;
  /** A 'YYYY-MM-DD' day, or null when no date is committed. */
  readonly dueOn: string | null;
  readonly state: PortalJourneyStepState;
  /** The studio marked this step's date as missed. */
  readonly missed: boolean;
}

/** The one action the client owes now — a review-and-approve on a published version. */
export interface PortalJourneyTurn {
  /** The id the portal review screen and `approvals/projections/:id/decision` take. */
  readonly deliverableVersionId: string;
  readonly title: string;
  /** An ISO-8601 instant: when the studio sent this version. */
  readonly sentAt: string;
}

export interface PortalJourney {
  readonly projectId: string;
  readonly steps: readonly PortalJourneyStep[];
  readonly yourTurn: PortalJourneyTurn | null;
  /** Every step met and nothing waits on the client. */
  readonly completed: boolean;
}

/**
 * Build the journey from published milestones (in timeline order) and the project's published
 * deliverable versions (newest first, as `listByProject` returns them).
 *
 * The first milestone not yet met is `now`; earlier ones are `done`, later ones `next`. Only the
 * newest version of each deliverable counts — an older undecided version a newer one replaced is
 * not the client's turn — and of those still undecided the one sent first is the turn.
 */
export function deriveJourney(
  projectId: string,
  milestones: readonly ProjectMilestoneRow[],
  versionsNewestFirst: readonly ClientProjectionRow[],
): PortalJourney {
  const nowIndex = milestones.findIndex((milestone) => milestone.status !== 'met');
  const steps = milestones.map((milestone, index): PortalJourneyStep => ({
    id: milestone.id,
    title: milestone.clientTitle ?? milestone.title,
    dueOn: milestone.dueOn,
    state: nowIndex === -1 || index < nowIndex ? 'done' : index === nowIndex ? 'now' : 'next',
    missed: milestone.status === 'missed',
  }));

  const seen = new Set<string>();
  let turn: ClientProjectionRow | null = null;
  for (const version of versionsNewestFirst) {
    if (seen.has(version.deliverableId)) continue;
    seen.add(version.deliverableId);
    if (version.projection.decision !== null) continue;
    if (turn === null || version.publishedAt <= turn.publishedAt) turn = version;
  }

  const yourTurn =
    turn === null
      ? null
      : {
          deliverableVersionId: turn.deliverableVersionId,
          title: turn.projection.title,
          sentAt: turn.publishedAt.toISOString(),
        };

  return {
    projectId,
    steps,
    yourTurn,
    completed: steps.length > 0 && nowIndex === -1 && yourTurn === null,
  };
}
