import { phaseBands } from '@tmanage/domain';
import type { TimelineMilestoneInput } from '@tmanage/domain';
import { PROJECT_MILESTONE_STATUSES } from '../../common/database/schema.js';
import type {
  MilestoneClientProjectionRow,
  ProjectMilestoneRow,
} from '../../common/database/schema.js';
import type { ProjectMilestoneStatus } from './project-milestones.repository.js';
import type { ClientMilestoneView, ProjectMilestoneView } from './project-milestones.controller.js';

/**
 * The two milestone projections — SEC / Portal milestones (x139).
 *
 * There are two, deliberately, and the difference between them is the security substance of this
 * slice. `25-AUTH-AND-TENANT-ISOLATION` §7 forbids building the client view by deleting fields
 * from the internal one ("Never implement client access as `serializeInternalObject(); delete
 * fields`."), so each view is built field by field and the client view simply never names the
 * internal ones. A column added to `project_milestones` tomorrow is invisible to a client until
 * somebody decides it should not be — the safe direction.
 *
 * The two `…View` interfaces are declared beside the controller that serialises them
 * (`project-milestones.controller.ts`) — the contracts check enumerates response views from the
 * service/controller/repository layer — and re-exported here so the projection functions and the
 * `e2e/contracts` pairing import them from one place.
 */

export type { ClientMilestoneView, ProjectMilestoneView };

/** The full internal record. */
export function toProjectMilestoneView(row: ProjectMilestoneRow): ProjectMilestoneView {
  return {
    id: row.id,
    projectId: row.projectId,
    title: row.title,
    dueOn: row.dueOn,
    status: row.status,
    published: row.published,
    createdByUserId: row.createdByUserId,
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * The client projection.
 *
 * Built field by field — no `createdByUserId`, no `published`. This is the audience boundary of
 * the slice; the revert proof pins it.
 */
export function toClientMilestoneView(row: ProjectMilestoneRow): ClientMilestoneView {
  return {
    id: row.id,
    projectId: row.projectId,
    title: row.title,
    dueOn: row.dueOn,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
  };
}

/** `true` when `value` is one of the milestone statuses (`planned | met | missed`). */
export function isProjectMilestoneStatus(value: unknown): value is ProjectMilestoneStatus {
  return (
    typeof value === 'string' && (PROJECT_MILESTONE_STATUSES as readonly string[]).includes(value)
  );
}

// ---- 53-07 (R19-c) milestones and phases on the timeline ----

/** 53-07. The milestone as the pure timeline functions read it. */
export function toTimelineMilestoneInput(
  row: ProjectMilestoneRow,
  phaseId: string | null,
): TimelineMilestoneInput {
  return {
    id: row.id,
    title: row.title,
    status: row.status,
    dueOn: row.dueOn,
    committedOn: row.committedOn ?? null,
    forecastOn: row.forecastOn ?? null,
    timelineOrder: row.timelineOrder ?? null,
    phaseId,
  };
}

/**
 * 53-07. What a publish answers the manager: the client copy as it now stands. Internal route only
 * (`project.manage`); the copy itself carries nothing the client may not see.
 */
export interface MilestonePublication {
  readonly milestoneId: string;
  readonly clientTitle: string;
  readonly committedOn: string | null;
  readonly status: string;
  readonly phaseName: string | null;
  /** An ISO-8601 instant. */
  readonly publishedAt: string;
}

export function toMilestonePublication(row: MilestoneClientProjectionRow): MilestonePublication {
  return {
    milestoneId: row.milestoneId,
    clientTitle: row.clientTitle,
    committedOn: row.committedOn,
    status: row.status,
    phaseName: row.phaseName,
    publishedAt: row.publishedAt.toISOString(),
  };
}

/** 53-07. One phase band on the client timeline: a name and its dates, nothing else. */
export interface PortalTimelinePhase {
  readonly name: string;
  readonly startsOn: string | null;
  readonly endsOn: string | null;
}

/** 53-07. One milestone on the client timeline — the three allowlisted fields (53-T-17). */
export interface PortalTimelineMilestone {
  readonly clientTitle: string;
  readonly committedOn: string | null;
  readonly status: string;
}

/** 53-07. `GET …/portal/projects/:projectId/timeline`. */
export interface PortalTimelineResponse {
  readonly phases: readonly PortalTimelinePhase[];
  readonly milestones: readonly PortalTimelineMilestone[];
  /** The latest publish instant (ISO-8601), or null when nothing is published. */
  readonly publishedAt: string | null;
}

/**
 * 53-07. The client timeline, built field by field from the published copies only — never from a
 * live milestone row, so no owner, internal title, forecast or reason can reach it. A phase band is
 * its explicit dates, else the span of the published copies carrying its name.
 */
export function toPortalTimeline(
  phases: readonly {
    readonly id: string;
    readonly name: string | null;
    readonly position: number | null;
    readonly startsOn: string | null;
    readonly endsOn: string | null;
  }[],
  copies: readonly MilestoneClientProjectionRow[],
): PortalTimelineResponse {
  const inputs: TimelineMilestoneInput[] = copies.map((copy) => ({
    id: copy.id,
    title: copy.clientTitle,
    status: copy.status,
    dueOn: null,
    committedOn: copy.committedOn,
    forecastOn: null,
    timelineOrder: null,
    phaseId:
      phases.find((phase) => phase.name !== null && phase.name === copy.phaseName)?.id ?? null,
  }));
  const bands = phaseBands(
    phases.map((phase) => ({
      id: phase.id,
      name: phase.name ?? '',
      position: phase.position ?? 0,
      startsOn: phase.startsOn,
      endsOn: phase.endsOn,
      colorToken: null,
    })),
    inputs,
  );
  let publishedAt: Date | null = null;
  for (const copy of copies) {
    if (publishedAt === null || copy.publishedAt > publishedAt) publishedAt = copy.publishedAt;
  }
  return {
    phases: bands.map((band) => ({
      name: band.name,
      startsOn: band.startsOn,
      endsOn: band.endsOn,
    })),
    milestones: copies.map((copy) => ({
      clientTitle: copy.clientTitle,
      committedOn: copy.committedOn,
      status: copy.status,
    })),
    publishedAt: publishedAt === null ? null : publishedAt.toISOString(),
  };
}
