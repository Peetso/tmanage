import { PROJECT_MILESTONE_STATUSES } from '../../common/database/schema.js';
import type { ProjectMilestoneRow } from '../../common/database/schema.js';
import type { ProjectMilestoneStatus } from './project-milestones.repository.js';

/**
 * The two milestone projections — SEC / Portal milestones (x139).
 *
 * There are two, deliberately, and the difference between them is the security substance of this
 * slice. `25-AUTH-AND-TENANT-ISOLATION` §7 forbids building the client view by deleting fields
 * from the internal one ("Never implement client access as `serializeInternalObject(); delete
 * fields`."), so each view is built field by field and the client view simply never names the
 * internal ones. A column added to `project_milestones` tomorrow is invisible to a client until
 * somebody decides it should not be — the safe direction.
 */

/**
 * A milestone as an **internal** principal is shown it — the full record behind `project.manage`.
 *
 * Carries `createdByUserId` and `published`: an internal manager may see who created a milestone
 * and whether it has been published to the client. This view never leaves the internal
 * `projects` path.
 */
export interface ProjectMilestoneView {
  readonly id: string;
  readonly projectId: string;
  readonly title: string;
  /** A 'YYYY-MM-DD' target day, or null when the date is not yet committed. */
  readonly dueOn: string | null;
  readonly status: ProjectMilestoneStatus;
  readonly published: boolean;
  readonly createdByUserId: string;
  /** An ISO-8601 instant on the wire. */
  readonly createdAt: string;
}

/**
 * A milestone as a **client** is shown it — the client projection.
 *
 * What is absent is the point. **`createdByUserId` is not here** — §4 excludes staff, so which
 * member of the agency created the milestone is an internal fact a client never learns. **`published`
 * is not here either**: a client only ever receives published milestones (the read filters
 * `published = 1`), so the flag would be a constant `true` that leaks the existence of the
 * unpublished/draft concept. The client is shown the milestone state (`status`) and its date, which
 * is what 12-PERMISSION-MATRIX §4 names.
 */
export interface ClientMilestoneView {
  readonly id: string;
  readonly projectId: string;
  readonly title: string;
  readonly dueOn: string | null;
  readonly status: ProjectMilestoneStatus;
  readonly createdAt: string;
}

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
    typeof value === 'string' &&
    (PROJECT_MILESTONE_STATUSES as readonly string[]).includes(value)
  );
}
