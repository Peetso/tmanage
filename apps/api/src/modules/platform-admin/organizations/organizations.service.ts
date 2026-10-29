import { ApiError, MESSAGES } from '../../../common/http/errors.js';
import { requireId, requireReason } from '../platform-admin.access.js';
import type { PlatformAdminActor } from '../platform-admin.guard.js';
import type { PlatformAdminRepository, PlatformCompanyRow } from '../platform-admin.repository.js';
import type {
  PlatformCompanyDetailView,
  PlatformCompanyView,
  PlatformOverviewView,
  RequestContext,
} from '../platform-admin.service.js';
import { platformAuditFor } from '../platform-audit.service.js';

/**
 * Platform admin · Organizations — the overview tiles, the company list and detail, and
 * suspension. Moved out of `PlatformAdminService` unchanged (PA-02 split); PA-07 owns it next.
 * Suspension and reactivation keep their required reason (SPEC P6, destructive list).
 */
export class PlatformOrganizationsService {
  constructor(
    private readonly repository: PlatformAdminRepository,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async overview(context: RequestContext): Promise<PlatformOverviewView> {
    const row = await this.repository.overview(this.now(), context.correlationId);
    return { ...row, computedAt: this.now().toISOString() };
  }

  async companies(
    rawSearch: unknown,
    context: RequestContext,
  ): Promise<{ readonly companies: readonly PlatformCompanyView[] }> {
    const search = typeof rawSearch === 'string' ? rawSearch.trim().slice(0, 190) : '';
    const rows = await this.repository.listCompanies(
      search === '' ? null : search,
      context.correlationId,
    );
    return { companies: rows.map(toCompanyView) };
  }

  async company(rawId: unknown, context: RequestContext): Promise<PlatformCompanyDetailView> {
    const id = requireId(rawId);
    const row = await this.repository.findCompany(id, context.correlationId);
    if (!row) throw new ApiError(404, 'not_found', MESSAGES.notFound);
    const events = await this.repository.listCompanyAudit(id, context.correlationId);
    return {
      company: toCompanyView(row),
      recentAdminEvents: events.map((event) => ({
        id: event.id,
        action: event.action,
        objectType: event.objectType,
        result: event.result,
        occurredAt: event.createdAt.toISOString(),
      })),
    };
  }

  async setSuspended(
    actor: PlatformAdminActor,
    rawId: unknown,
    suspend: boolean,
    body: { readonly reason?: unknown },
    context: RequestContext,
  ): Promise<{ readonly company: PlatformCompanyView }> {
    const id = requireId(rawId);
    const reason = requireReason(body?.reason);
    const row = await this.repository.findCompany(id, context.correlationId);
    if (!row) throw new ApiError(404, 'not_found', MESSAGES.notFound);
    const already = row.suspendedAt !== null;
    if (already === suspend) {
      throw new ApiError(
        409,
        'conflict',
        suspend ? 'This company is already suspended.' : 'This company is not suspended.',
      );
    }
    await this.repository.setSuspended(
      id,
      suspend,
      platformAuditFor(actor, context, {
        action: suspend ? 'platform.company_suspended' : 'platform.company_reactivated',
        targetType: 'organization',
        targetId: id,
        targetLabel: row.name,
        organizationId: id,
        reason,
      }),
    );
    const updated = await this.repository.findCompany(id, context.correlationId);
    return { company: toCompanyView(updated ?? row) };
  }
}

export function toCompanyView(row: PlatformCompanyRow): PlatformCompanyView {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    ownerEmail: row.ownerEmail,
    people: row.people,
    clients: row.clients,
    projects: row.projects,
    plan: row.planId,
    createdAt: row.createdAt.toISOString(),
    lastActiveAt: row.lastActiveAt ? row.lastActiveAt.toISOString() : null,
    status: row.archivedAt ? 'archived' : row.suspendedAt ? 'suspended' : 'active',
    suspendedAt: row.suspendedAt ? row.suspendedAt.toISOString() : null,
  };
}
