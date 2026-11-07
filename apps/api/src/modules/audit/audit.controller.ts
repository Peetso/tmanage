import { Controller, Get, Inject, Param, Query, Res, StreamableFile } from '@nestjs/common';
import type { Principal } from '@tmanage/domain';
import { Ctx, CurrentPrincipal, RequireCapability } from '../../common/http/decorators.js';
import { ApiError } from '../../common/http/errors.js';
import { AUDIT_SERVICE } from '../../common/http/tokens.js';
import type { TenantContext } from '../../common/database/tenant-context.js';
import type { AdminAuditEventView, AuditEventChangeEntry, AuditService } from './audit.service.js';
import { auditEventsToCsv } from './audit-export-csv.js';

/** The one method the export needs of the framework reply: set a header before the first byte. */
interface HeaderWriter {
  header(name: string, value: string): unknown;
}

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

  /**
   * B13 — one event's before/after rows, behind `audit.read`, for the viewer's detail aside.
   * Scope narrowing and the 404 for an event the caller may not see live in the service.
   */
  @Get('events/:eventId/changes')
  @RequireCapability('audit.read')
  async changes(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('eventId') eventId: string,
  ): Promise<{ readonly changes: readonly AuditEventChangeEntry[] }> {
    return { changes: await this.audit.changesForViewer(context, principal, eventId) };
  }

  /**
   * ADM-09 export (x118) — the bulk-egress half, behind `audit.export`.
   *
   * A distinct capability from the viewer's `audit.read`: exporting the whole trail is a stronger
   * grant than paging it, so `CapabilityGuard` refuses a caller without `audit.export` with the
   * ordinary 403 before the handler runs, and {@link AuditService.exportForViewer} checks again.
   * The filter surface is the viewer's (`before?`, `actorId?`, `entityId?`); there is no `limit`,
   * because an export is bounded by the service's row cap rather than a page size, and past that
   * cap the service answers 413.
   *
   * The body is a `StreamableFile` of the CSV, which keeps Nest in its own response mode — the
   * interceptors and the exception filter still shape everything that is not the bytes — and the
   * headers force a safe download: `attachment` so a browser saves rather than renders it,
   * `nosniff` so it is not re-typed, `private, no-store` so no shared cache keeps a copy of the
   * trail.
   */
  @Get('events/export')
  @RequireCapability('audit.export')
  async export(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Res({ passthrough: true }) reply: HeaderWriter,
    @Query('before') before?: string,
    @Query('actorId') actorId?: string,
    @Query('entityId') entityId?: string,
  ): Promise<StreamableFile> {
    const events = await this.audit.exportForViewer(context, principal, {
      ...(before ? { before } : {}),
      ...(actorId ? { actorId } : {}),
      ...(entityId ? { entityId } : {}),
    });

    const csv = auditEventsToCsv(events);
    // F53 (wave 9 S8): the export itself is audited before a byte leaves, and fails closed — if
    // the row cannot be written this throws and no CSV is returned. Filter flags only, no values.
    await this.audit.recordStandalone(context, {
      action: 'audit.exported',
      result: 'allowed',
      objectId: context.organizationId,
      actorUserId: principal.userId,
      metadata: {
        export_kind: 'audit_events',
        row_count: events.length,
        filter_actor: Boolean(actorId),
        filter_entity: Boolean(entityId),
        filter_before: Boolean(before),
      },
    });
    reply.header('content-type', 'text/csv; charset=utf-8');
    reply.header('content-disposition', 'attachment; filename="audit-events.csv"');
    reply.header('x-content-type-options', 'nosniff');
    reply.header('cache-control', 'private, no-store');
    return new StreamableFile(Buffer.from(csv, 'utf-8'), { type: 'text/csv; charset=utf-8' });
  }
}
