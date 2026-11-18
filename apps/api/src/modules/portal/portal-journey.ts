import type {
  ClientJourneyStepKind,
  ClientJourneyStepRow,
  ClientProjectionRow,
  ProjectMilestoneRow,
} from '../../common/database/schema.js';
import type { ClientReview } from '../approvals/client-review.js';

/**
 * 52-27 — the client journey stepper, derived. The steps are the client's own journey steps
 * (`client_journey_steps`, 0363: fill a form, send files, sign, accept a meeting) followed by the
 * milestones the studio published; the client's turn is the first open journey step it can act on,
 * else the oldest published deliverable version still waiting on the client's decision. Pure, so
 * the state rules are unit-proven without a database.
 */

/** Where one step sits on the client's path. */
export type PortalJourneyStepState = 'done' | 'now' | 'next';

/** What a step is: a published milestone, or a client journey step of one kind. */
export type PortalJourneyStepKind = 'milestone' | ClientJourneyStepKind;

/**
 * The server-side evidence a client journey step is done by, read for one client on one project.
 * Nothing here comes from the request: each set is what the database holds for that client.
 */
export interface JourneyEvidence {
  /** Completed signature requests on the project that a person of this client signed. */
  readonly signedRequestIds: ReadonlySet<string>;
  /** Meetings on the project that a person of this client accepted. */
  readonly acceptedMeetingIds: ReadonlySet<string>;
  /** When a person of this client last completed an upload to the project, or null. */
  readonly lastUploadAt: Date | null;
}

/**
 * Whether one journey step is done, from its evidence alone: a form step by the submission the
 * portal stored on it, an upload step by an upload this client completed after the step was set,
 * a sign step by its request signed by this client, a meeting step by this client's acceptance.
 * A step not linked to its object yet is never done.
 */
export function isJourneyStepDone(step: ClientJourneyStepRow, evidence: JourneyEvidence): boolean {
  switch (step.kind) {
    case 'form':
      return step.evidenceId !== null;
    case 'upload':
      return evidence.lastUploadAt !== null && evidence.lastUploadAt >= step.createdAt;
    case 'sign':
      return step.refId !== null && evidence.signedRequestIds.has(step.refId);
    case 'meeting':
      return step.refId !== null && evidence.acceptedMeetingIds.has(step.refId);
  }
}

export interface PortalJourneyStep {
  readonly id: string;
  readonly kind: PortalJourneyStepKind;
  /** The client-safe name (53-07 `client_title`), falling back to the milestone title. */
  readonly title: string;
  /** A 'YYYY-MM-DD' day, or null when no date is committed. */
  readonly dueOn: string | null;
  readonly state: PortalJourneyStepState;
  /** The studio marked this step's date as missed. */
  readonly missed: boolean;
}

/** The one action the client owes now: a review-and-approve on a published version... */
export interface PortalJourneyReviewTurn {
  readonly kind: 'review';
  /** The id the portal review screen and `approvals/projections/:id/decision` take. */
  readonly deliverableVersionId: string;
  readonly title: string;
  /** An ISO-8601 instant: when the studio sent this version. */
  readonly sentAt: string;
}

/** ...or the open journey step, opened on its own screen. */
export interface PortalJourneyStepTurn {
  readonly kind: ClientJourneyStepKind;
  readonly stepId: string;
  readonly title: string;
  /**
   * What the step's screen opens: the step itself for a form, the signature request for a sign
   * step, the meeting for a meeting step; null for an upload (the project's Files page).
   */
  readonly targetId: string | null;
}

export type PortalJourneyTurn = PortalJourneyReviewTurn | PortalJourneyStepTurn;

export interface PortalJourney {
  readonly projectId: string;
  readonly steps: readonly PortalJourneyStep[];
  readonly yourTurn: PortalJourneyTurn | null;
  /** Every step met and nothing waits on the client. */
  readonly completed: boolean;
}

/** The client's own journey steps (in sequence order) with the evidence read for that client. */
export interface JourneyClientSteps {
  readonly steps: readonly ClientJourneyStepRow[];
  readonly evidence: JourneyEvidence;
}

/** A step the client can open now: an upload needs no link, the other kinds need their object. */
function stepTurn(step: ClientJourneyStepRow): PortalJourneyStepTurn | null {
  if (step.kind === 'upload') {
    return { kind: 'upload', stepId: step.id, title: step.title, targetId: null };
  }
  if (step.refId === null) return null;
  return {
    kind: step.kind,
    stepId: step.id,
    title: step.title,
    targetId: step.kind === 'form' ? step.id : step.refId,
  };
}

/**
 * Build the journey from the client's journey steps, published milestones (in timeline order)
 * and the project's published deliverable versions (newest first, as `listByProject` returns
 * them).
 *
 * The journey steps come first, then the milestones. The first step not yet done (a journey step
 * without its evidence, a milestone not met) is `now`; earlier ones are `done`, later ones `next`.
 * When `now` is a journey step the client can open, that step is the turn. Otherwise the turn is a
 * review: only the newest version of each deliverable counts — an older undecided version a newer
 * one replaced is not the client's turn — and of those, the one sent first whose live review waits
 * on this reader (`reviews`, from the approvals — never the frozen projection, whose `decision` the
 * product publishes as null, so a decided version stayed "Your turn": TESTUX P1 5).
 */
export function deriveJourney(
  projectId: string,
  client: JourneyClientSteps,
  milestones: readonly ProjectMilestoneRow[],
  versionsNewestFirst: readonly ClientProjectionRow[],
  reviews: ReadonlyMap<string, ClientReview>,
): PortalJourney {
  const done = [
    ...client.steps.map((step) => isJourneyStepDone(step, client.evidence)),
    ...milestones.map((milestone) => milestone.status === 'met'),
  ];
  const nowIndex = done.findIndex((isDone) => !isDone);
  const stateAt = (index: number): PortalJourneyStepState =>
    nowIndex === -1 || index < nowIndex ? 'done' : index === nowIndex ? 'now' : 'next';
  const offset = client.steps.length;
  const steps: PortalJourneyStep[] = [
    ...client.steps.map((step, index): PortalJourneyStep => ({
      id: step.id,
      kind: step.kind,
      title: step.title,
      dueOn: null,
      state: stateAt(index),
      missed: false,
    })),
    ...milestones.map((milestone, index): PortalJourneyStep => ({
      id: milestone.id,
      kind: 'milestone',
      title: milestone.clientTitle ?? milestone.title,
      dueOn: milestone.dueOn,
      state: stateAt(offset + index),
      missed: milestone.status === 'missed',
    })),
  ];

  const nowStep = nowIndex >= 0 && nowIndex < offset ? client.steps[nowIndex] : undefined;
  const openStep = nowStep ? stepTurn(nowStep) : null;

  const seen = new Set<string>();
  let turn: ClientProjectionRow | null = null;
  for (const version of versionsNewestFirst) {
    if (seen.has(version.deliverableId)) continue;
    seen.add(version.deliverableId);
    if (reviews.get(version.deliverableVersionId)?.awaitingYou !== true) continue;
    if (turn === null || version.publishedAt <= turn.publishedAt) turn = version;
  }

  const yourTurn: PortalJourneyTurn | null =
    openStep ??
    (turn === null
      ? null
      : {
          kind: 'review',
          deliverableVersionId: turn.deliverableVersionId,
          title: turn.projection.title,
          sentAt: turn.publishedAt.toISOString(),
        });

  return {
    projectId,
    steps,
    yourTurn,
    completed: steps.length > 0 && nowIndex === -1 && yourTurn === null,
  };
}
