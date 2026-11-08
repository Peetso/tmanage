import type { TenantContext } from '../../../common/database/tenant-context.js';
import { ApiError, MESSAGES } from '../../../common/http/errors.js';
import type {
  IncidentRecord,
  IncidentStatus,
  PlatformIncidentsRepository,
} from './incidents.repository.js';

/**
 * A17 — the workspace owner's incidents page: `GET /v1/organizations/:orgSlug/admin/incidents`.
 *
 * A workspace sees an incident when it is published on the status page, or when the register names
 * this workspace among the affected organizations AND customers have been notified. Only the six
 * public fields plus `affectsWorkspace` ever leave: never severity, countries, data categories, the
 * other affected organizations or the legal clocks — those stay in the platform register.
 */

export interface WorkspaceIncidentView {
  readonly id: string;
  readonly component: string;
  readonly status: IncidentStatus;
  readonly title: string;
  readonly body: string;
  readonly startedAt: string;
  readonly resolvedAt: string | null;
  readonly affectsWorkspace: boolean;
}

/** The incidents one workspace may see, newest first as given. Pure. */
export function toWorkspaceIncidents(
  records: readonly IncidentRecord[],
  organizationId: string,
): WorkspaceIncidentView[] {
  const views: WorkspaceIncidentView[] = [];
  for (const record of records) {
    const named = record.affectedOrgIds.includes(organizationId);
    const announced = named && record.notifiedCustomersAt !== null;
    if (!record.published && !announced) continue;
    views.push({
      id: record.id,
      component: record.component,
      status: record.status,
      title: record.title,
      body: record.body,
      startedAt: record.startedAt.toISOString(),
      resolvedAt: record.resolvedAt === null ? null : record.resolvedAt.toISOString(),
      affectsWorkspace: named,
    });
  }
  return views;
}

export class WorkspaceIncidentsService {
  constructor(
    private readonly repository: Pick<PlatformIncidentsRepository, 'listForWorkspaces'>,
  ) {}

  async list(context: TenantContext): Promise<{ readonly incidents: WorkspaceIncidentView[] }> {
    // Defence in depth behind the controller's coarse capability gate.
    if (!context.capabilities.includes('org.manage')) {
      throw new ApiError(403, 'forbidden', MESSAGES.forbidden);
    }
    const records = await this.repository.listForWorkspaces(context.correlationId);
    return { incidents: toWorkspaceIncidents(records, context.organizationId) };
  }
}
