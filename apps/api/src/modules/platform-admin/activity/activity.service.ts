import type { PlatformAdminRepository } from '../platform-admin.repository.js';
import { MAX_PLATFORM_AUDIT } from '../platform-admin.repository.js';
import type { PlatformAuditEventView, RequestContext } from '../platform-admin.service.js';

/**
 * Platform admin · Activity — the platform admins' own action log. Moved out of
 * `PlatformAdminService` unchanged (PA-02 split); PA-09 owns it next.
 */
export class PlatformActivityService {
  constructor(private readonly repository: PlatformAdminRepository) {}

  async auditLog(
    context: RequestContext,
  ): Promise<{ readonly events: readonly PlatformAuditEventView[] }> {
    const rows = await this.repository.listAudit(MAX_PLATFORM_AUDIT, context.correlationId);
    return {
      events: rows.map((row) => ({
        id: row.id,
        actorEmail: row.actorEmail,
        action: row.action,
        targetType: row.targetType,
        targetId: row.targetId,
        targetLabel: row.targetLabel,
        reason: row.reason,
        occurredAt: row.createdAt.toISOString(),
      })),
    };
  }
}
