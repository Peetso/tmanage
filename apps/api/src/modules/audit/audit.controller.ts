import { Controller, Get, Inject, Query } from '@nestjs/common';
import type { Principal } from '@tmanage/domain';
import { Ctx, CurrentPrincipal, RequireCapability } from '../../common/http/decorators.js';
import { ApiError } from '../../common/http/errors.js';
import { AUDIT_SERVICE } from '../../common/http/tokens.js';
import type { TenantContext } from '../../common/database/tenant-context.js';
import type { AdminAuditEventView, AuditService } from './audit.service.js';

/**
 * ADM audit viewer (x115). The audit module's first HTTP surface: a read of the trail behind
 * `audit.read`.
 *
 * Like every tenant-scoped controller here it never reads `organizationId` from the body, a
 * header or its own `:orgSlug` segment — it passes on the {@link TenantContext} the guard built
 * from a membership row, and the query carries no tenant field, so a caller cannot name another
 * tenant's trail. The scope narrowing (org-wide vs own-activity) and the `audit.read` gate live
 * in {@link AuditService.listForViewer}; the guard's `@RequireCapability` refuses a caller without
 * the capability with the ordinary 403 before the handler runs, and the service checks again.
 *
 * The response is `{ events: AdminAuditEventView[] }` — a narrow projection with no `metadata`,
 * `correlationId` or `effectiveActorId`, newest first, keyset-paginated. The wrapper leaves room
 * for a later `nextBefore` cursor without reshaping the body.
 */
@Controller('v1/organizations/:orgSlug/audit')
export class AuditController {
  constructor(@Inject(AUDIT_SERVICE) private readonly audit: AuditService) {}

  @Get('events')
  @RequireCapability('audit.read')
  async list(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Query('limit') limit?: string,
    @Query('before') before?: string,
    @Query('actorId') actorId?: string,
    @Query('entityId') entityId?: string,
  ): Promise<{ readonly events: readonly AdminAuditEventView[] }> {
    const details: { field: string; message: string }[] = [];

    // A bounded list, validated at the boundary: a `limit` outside `[1, 50]`, or one that is not
    // an integer, is a 400 rather than a silent clamp (x103 bad-range precedent). The service
    // clamps defensively as well, so an out-of-range value can never reach the repository.
    const parsedLimit = limit === undefined ? undefined : Number(limit);
    if (
      parsedLimit !== undefined &&
      (!Number.isSafeInteger(parsedLimit) || parsedLimit < 1 || parsedLimit > 50)
    ) {
      details.push({ field: 'limit', message: 'must be an integer between 1 and 50' });
    }

    if (details.length > 0) {
      throw new ApiError(400, 'validation_failed', 'The query is invalid', details);
    }

    return {
      events: await this.audit.listForViewer(context, principal, {
        ...(parsedLimit === undefined ? {} : { limit: parsedLimit }),
        ...(before ? { before } : {}),
        ...(actorId ? { actorId } : {}),
        ...(entityId ? { entityId } : {}),
      }),
    };
  }
}
