import { Controller, Get, Inject, Module, Query, Res, StreamableFile } from '@nestjs/common';
import type { DynamicModule } from '@nestjs/common';
import { isAuditAction } from '@tmanage/domain';
import type { Principal } from '@tmanage/domain';
import { Ctx, CurrentPrincipal, RequireCapability } from '../../common/http/decorators.js';
import { ApiError } from '../../common/http/errors.js';
import { AUDIT_SERVICE } from '../../common/http/tokens.js';
import type { TenantContext } from '../../common/database/tenant-context.js';
import type { AdminAuditEventView, AuditService } from './audit.service.js';
import { auditEventsToCsv } from './audit-export-csv.js';

/** The one method the download needs of the framework reply: set a header before the first byte. */
interface HeaderWriter {
  header(name: string, value: string): unknown;
}

const CSV_CONTENT_TYPE = 'text/csv; charset=utf-8';
const CSV_FILENAME = 'audit-export.csv';

/**
 * The widest audit window one export may name, in days.
 *
 * `26-THREAT-MODELS` treats a bulk export of the security trail as an egress sink, and x118 already
 * caps the *rows* an export can carry (413 past `EXPORT_MAX_ROWS`). This slice caps the *request*
 * instead: a from/to window wider than this is refused at the boundary with a 400, before any read,
 * so a caller cannot ask the database to scan a year-plus of trail in one download and then discover
 * at the row cap that it was too much. A caller who genuinely wants more narrows the window and
 * exports in parts. A year plus a day of slack (a leap year is 366) is the ceiling.
 */
const MAX_EXPORT_WINDOW_DAYS = 366;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Parse an ISO-8601 instant to epoch ms, or `null` when the value is absent or unparseable. */
function parseInstant(value: string | undefined): number | null {
  if (value === undefined || value.trim() === '') return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

/**
 * ADM-09 filtered export (x197) — a **date-windowed** CSV of the audit trail, behind `audit.export`.
 *
 * A distinct surface from x118's `GET .../audit/events/export`, which pages the whole trail (or
 * refuses at the row cap) filtered only by actor/entity. This route adds the two things an operator
 * asked of the audit screen and the trail did not answer: a bounded **from/to window** and an
 * **action** filter, so an export can be "role changes in March" rather than "everything, capped".
 *
 * The security-critical half is **not** re-implemented here — it is inherited from
 * {@link AuditService.exportForViewer}, unchanged:
 *
 *   - **Capability.** `@RequireCapability('audit.export')` refuses a caller without the stronger,
 *     distinct export grant with the ordinary 403 before the handler runs, and `exportForViewer`
 *     checks again — a caller with only `audit.read` never reaches the bytes.
 *   - **Tenant scope + own-activity narrowing.** `exportForViewer` scopes every read to the
 *     caller's `TenantContext` and overwrites `actorUserId` to the caller for a non-org-wide
 *     principal, so an audit row can never cross tenants and a narrow caller cannot widen past
 *     their own activity by naming another actor.
 *   - **Row cap.** The inherited `EXPORT_MAX_ROWS` ceiling (413) still bounds the read.
 *
 * This controller owns three things and only three: the **window validation** (a missing, malformed,
 * inverted or over-wide window is a 400 with no read), the **in-memory window/action filter** over
 * the narrow projection the service returns, and the **CSV serialization** through the shared,
 * formula-injection-guarded {@link auditEventsToCsv}. The response is a `StreamableFile` with the
 * same safe-download headers the other exports use: `attachment`, `nosniff`, `private, no-store`.
 */
@Controller('v1/organizations/:orgSlug/audit')
export class AuditExportController {
  constructor(@Inject(AUDIT_SERVICE) private readonly audit: AuditService) {}

  @Get('export.csv')
  @RequireCapability('audit.export')
  async export(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Res({ passthrough: true }) reply: HeaderWriter,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('actor') actor?: string,
    @Query('action') action?: string,
  ): Promise<StreamableFile> {
    const fromMs = parseInstant(from);
    const toMs = parseInstant(to);

    // The window is bounded at the boundary, before any read. Each failure is a 400 that names the
    // field, never a silent clamp: a caller who fat-fingered the range should be told, not handed a
    // different export than they asked for.
    const details: { field: string; message: string }[] = [];
    if (fromMs === null) details.push({ field: 'from', message: 'must be an ISO-8601 instant' });
    if (toMs === null) details.push({ field: 'to', message: 'must be an ISO-8601 instant' });
    if (fromMs !== null && toMs !== null) {
      if (fromMs > toMs) {
        details.push({ field: 'to', message: 'must not be earlier than from' });
      } else if (toMs - fromMs > MAX_EXPORT_WINDOW_DAYS * MS_PER_DAY) {
        details.push({
          field: 'to',
          message: `the window must not exceed ${MAX_EXPORT_WINDOW_DAYS} days`,
        });
      }
    }
    if (details.length > 0) {
      throw new ApiError(400, 'validation_failed', 'The export window is invalid', details);
    }

    // Inherit the capability gate (403), the tenant scope, the own-activity narrowing and the row
    // cap (413) from the service. `actor` is the service's `actorId` filter; `action` and the
    // date window are this controller's own, applied over the narrow projection below.
    const events = await this.audit.exportForViewer(context, principal, {
      ...(actor ? { actorId: actor } : {}),
    });

    const trimmed = action ? action.trim() : '';
    const windowed = events.filter((event: AdminAuditEventView) => {
      const occurredMs = Date.parse(event.occurredAt);
      if (Number.isNaN(occurredMs) || occurredMs < fromMs! || occurredMs > toMs!) return false;
      if (trimmed !== '' && event.action !== trimmed) return false;
      return true;
    });

    const body = Buffer.from(auditEventsToCsv(windowed), 'utf-8');
    // F53 (wave 9 S8): one audit row per export, written before the bytes are returned; if it
    // cannot be written this throws and nothing is handed out. The window and the filter shape
    // only — an action filter is named only when it is a catalogued action, never free text.
    await this.audit.recordStandalone(context, {
      action: 'audit.exported',
      result: 'allowed',
      objectId: context.organizationId,
      actorUserId: principal.userId,
      metadata: {
        export_kind: 'audit_window',
        row_count: windowed.length,
        window_from: new Date(fromMs!).toISOString(),
        window_to: new Date(toMs!).toISOString(),
        filter_actor: Boolean(actor),
        filter_action: trimmed === '' ? null : isAuditAction(trimmed) ? trimmed : 'other',
      },
    });
    reply.header('content-type', CSV_CONTENT_TYPE);
    reply.header('content-length', String(body.byteLength));
    reply.header('content-disposition', `attachment; filename="${CSV_FILENAME}"`);
    reply.header('x-content-type-options', 'nosniff');
    reply.header('cache-control', 'private, no-store');
    return new StreamableFile(body, { type: CSV_CONTENT_TYPE, length: body.byteLength });
  }
}

/**
 * The filtered-export module (x197). A module of its own rather than another controller on the
 * global `AuditModule`, so it stays file-disjoint from x118's viewer/export controller; it depends
 * only on the globally-exported `AUDIT_SERVICE`, so it wires no providers.
 */
@Module({})
export class AuditExportModule {
  static register(): DynamicModule {
    return {
      module: AuditExportModule,
      controllers: [AuditExportController],
    };
  }
}
