import { PROJECT_MILESTONE_STATUSES } from '../../common/database/schema.js';
import type { ProjectMilestoneRow } from '../../common/database/schema.js';
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
