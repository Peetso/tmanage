import { PROJECT_RISK_SEVERITIES, PROJECT_RISK_STATUSES } from '../../common/database/schema.js';
import type { ProjectRiskRow } from '../../common/database/schema.js';
import type { ProjectRiskSeverity, ProjectRiskStatus } from './project-risks.repository.js';
import type { ClientRiskView, ProjectRiskView } from './project-risks.controller.js';

/**
 * The two risk projections — SEC / Portal risks (x140).
 *
 * The view *types* live in the controller ({@link ProjectRiskView}, {@link ClientRiskView}) — the
 * file the contracts checker scans for the wire shapes and the one that serialises them — and this
 * file holds the *mapping*: how a `project_risks` row becomes each view. `25-AUTH-AND-TENANT-ISOLATION`
 * §7 forbids building the client view by deleting fields from the internal one ("Never implement
 * client access as `serializeInternalObject(); delete fields`."), so each view is built field by
 * field and the client mapping simply never names the internal columns. A column added to
 * `project_risks` tomorrow is invisible to a client until somebody decides it should not be — the safe
 * direction.
 */

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
