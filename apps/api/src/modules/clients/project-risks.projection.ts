import { PROJECT_RISK_SEVERITIES, PROJECT_RISK_STATUSES } from '../../common/database/schema.js';
import type { ProjectRiskRow } from '../../common/database/schema.js';
import type { ProjectRiskSeverity, ProjectRiskStatus } from './project-risks.repository.js';

/**
 * The two risk projections — SEC / Portal risks (x140).
 *
 * There are two, deliberately, and the difference between them is the security substance of this
 * slice. `25-AUTH-AND-TENANT-ISOLATION` §7 forbids building the client view by deleting fields from
 * the internal one ("Never implement client access as `serializeInternalObject(); delete fields`."),
 * so each view is built field by field and the client view simply never names the internal ones. A
 * column added to `project_risks` tomorrow is invisible to a client until somebody decides it should
 * not be — the safe direction.
 */

/**
 * A risk as an **internal** principal is shown it — the full record behind `project.manage`.
 *
 * Carries the internal substance a client must never see: `title` (the staff-facing handle),
 * `internalNote` (the detail behind the risk), `createdByUserId` (who recorded it) and `published`
 * (whether it has reached the client). This view never leaves the internal `projects` path.
 */
export interface ProjectRiskView {
  readonly id: string;
  readonly projectId: string;
  readonly title: string;
  readonly severity: ProjectRiskSeverity;
  readonly status: ProjectRiskStatus;
  /** The internal-only detail. Nullable. Never present on {@link ClientRiskView}. */
  readonly internalNote: string | null;
  /** The client-facing description — the same text the client projection carries. */
  readonly clientSummary: string;
  readonly published: boolean;
  readonly createdByUserId: string;
  /** An ISO-8601 instant on the wire. */
  readonly createdAt: string;
}

/**
 * A risk as a **client** is shown it — the client projection.
 *
 * What is absent is the point, and it is the whole slice. **`title` and `internalNote` are not
 * here** — they are the internal substance (12-PERMISSION-MATRIX §4 gives the client "published
 * risk", the client-facing summary, never the internal note). **`createdByUserId` is not here** —
 * §4 excludes staff, so which member of the agency recorded the risk is never learned. **`published`
 * is not here either**: a client only ever receives published risks (the read filters
 * `published = 1`), so the flag would be a constant `true` that leaks the existence of the
 * draft concept. The client is shown the client summary, the severity and the status — and nothing
 * else.
 */
export interface ClientRiskView {
  readonly id: string;
  readonly projectId: string;
  readonly severity: ProjectRiskSeverity;
  readonly status: ProjectRiskStatus;
  readonly clientSummary: string;
  readonly createdAt: string;
}

/** The full internal record. */
export function toProjectRiskView(row: ProjectRiskRow): ProjectRiskView {
  return {
    id: row.id,
    projectId: row.projectId,
    title: row.title,
    severity: row.severity,
    status: row.status,
    internalNote: row.internalNote,
    clientSummary: row.clientSummary,
    published: row.published,
    createdByUserId: row.createdByUserId,
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * The client projection.
 *
 * Built field by field — no `title`, no `internalNote`, no `createdByUserId`, no `published`. This is
 * the audience boundary of the slice; the revert proof pins it. The internal note — the substance —
 * is never named here, so there is no code path that could carry it across to a client.
 */
export function toClientRiskView(row: ProjectRiskRow): ClientRiskView {
  return {
    id: row.id,
    projectId: row.projectId,
    severity: row.severity,
    status: row.status,
    clientSummary: row.clientSummary,
    createdAt: row.createdAt.toISOString(),
  };
}

/** `true` when `value` is one of the risk severities (`low | medium | high`). */
export function isProjectRiskSeverity(value: unknown): value is ProjectRiskSeverity {
  return (
    typeof value === 'string' && (PROJECT_RISK_SEVERITIES as readonly string[]).includes(value)
  );
}

/** `true` when `value` is one of the risk statuses (`open | mitigated | closed`). */
export function isProjectRiskStatus(value: unknown): value is ProjectRiskStatus {
  return typeof value === 'string' && (PROJECT_RISK_STATUSES as readonly string[]).includes(value);
}
