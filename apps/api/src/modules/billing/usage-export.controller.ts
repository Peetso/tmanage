import { Controller, Get, Inject, Module, Query, Res, StreamableFile } from '@nestjs/common';
import type { DynamicModule, Provider } from '@nestjs/common';
import type { Principal } from '@tmanage/domain';
import { Ctx, CurrentPrincipal, RequireCapability } from '../../common/http/decorators.js';
import { ApiError } from '../../common/http/errors.js';
import { TENANT_DATABASE } from '../../common/http/tokens.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import { toCsv } from '../insights/csv.js';
import { UsageExportService, type UsageExportView } from './usage-export.service.js';

/** The one method the download needs of the framework reply: set a header before the first byte. */
interface HeaderWriter {
  header(name: string, value: string): unknown;
}

const CSV_CONTENT_TYPE = 'text/csv; charset=utf-8';
const CSV_FILENAME = 'usage-export.csv';

/** The header row of the export — the {@link UsageExportView} fields, in the order the export emits. */
const USAGE_CSV_HEADER = [
  'metricKey',
  'usedValue',
  'reservedValue',
  'thresholdBand',
  'reconciledAt',
  'updatedAt',
] as const;

/**
 * The widest usage window one export may name, in days.
 *
 * `26-THREAT-MODELS` treats a bulk export as an egress sink, and the service already caps the *rows*
 * an export can carry (413 past `USAGE_EXPORT_MAX_ROWS`). This bound is on the *request*: a from/to
 * window wider than this is refused at the boundary with a 400, before any read, so a caller cannot
 * ask for a year-plus scan in one download. A year plus a day of slack (a leap year is 366) is the
 * ceiling — the same value the ADM-09 audit export (x197) uses.
 */
const MAX_EXPORT_WINDOW_DAYS = 366;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Private DI token, so no shared `tokens.ts` edit is needed (the usage-alerts posture). */
const USAGE_EXPORT_SERVICE = Symbol.for('tmanage.UsageExportService');

/** Parse an ISO-8601 instant to epoch ms, or `null` when the value is absent or unparseable. */
function parseInstant(value: string | undefined): number | null {
  if (value === undefined || value.trim() === '') return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

/** Serialize the windowed projection to a formula-injection-guarded CSV document. */
function usageExportToCsv(rows: readonly UsageExportView[]): string {
  return toCsv([
    [...USAGE_CSV_HEADER],
    ...rows.map((row) => [
      row.metricKey,
      row.usedValue,
      row.reservedValue,
      row.thresholdBand,
      row.reconciledAt ?? '',
      row.updatedAt,
    ]),
  ]);
}

/**
 * Billing & entitlements (module 19, x227) — a **date-windowed** CSV of the org's usage counters,
 * behind `org.manage`. A deeper flow over `usage_counters` than the x200 usage-alerts read: it emits
 * the counters as a spreadsheet-safe download rather than evaluating alert thresholds.
 *
 * The security-critical halves are **not** re-implemented here:
 *
 *   - **Capability + tenant scope.** `@RequireCapability('org.manage')` refuses a caller without the
 *     grant with the ordinary 403 before the handler runs, and {@link UsageExportService.listForExport}
 *     makes the authoritative org-scoped `authorize()` decision again and scopes every read to the
 *     caller's `TenantContext`, so a usage counter can never cross tenants.
 *   - **Row cap.** The service refuses past `USAGE_EXPORT_MAX_ROWS` with a 413.
 *   - **Formula-injection guard.** The CSV goes through the shared, guarded `toCsv` (insights/csv), so a
 *     cell that begins `= + - @` (or the tab/CR that lead into a formula) is neutralised, never
 *     hand-rolled here.
 *
 * This controller owns three things and only three: the **window validation** (a missing, malformed,
 * inverted or over-wide window is a 400 with no read), the **in-memory window filter** over the
 * projection (on `updatedAt`), and the **CSV serialization**. The response is a `StreamableFile` with
 * the same safe-download headers the other exports use: `attachment`, `nosniff`, `private, no-store`.
 */
@Controller('v1/organizations/:orgSlug/billing/usage')
export class UsageExportController {
  constructor(@Inject(USAGE_EXPORT_SERVICE) private readonly usage: UsageExportService) {}

  @Get('export.csv')
  @RequireCapability('org.manage')
  async export(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Res({ passthrough: true }) reply: HeaderWriter,
    @Query('from') from?: string,
    @Query('to') to?: string,
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

    // Inherit the capability gate (403), the tenant scope and the row cap (413) from the service. The
    // date window is this controller's own, applied over the narrow projection below on `updatedAt`.
    const rows = await this.usage.listForExport(context, principal);
    const windowed = rows.filter((row) => {
      const updatedMs = Date.parse(row.updatedAt);
      return !Number.isNaN(updatedMs) && updatedMs >= fromMs! && updatedMs <= toMs!;
    });

    const body = Buffer.from(usageExportToCsv(windowed), 'utf-8');
    reply.header('content-type', CSV_CONTENT_TYPE);
    reply.header('content-length', String(body.byteLength));
    reply.header('content-disposition', `attachment; filename="${CSV_FILENAME}"`);
    reply.header('x-content-type-options', 'nosniff');
    reply.header('cache-control', 'private, no-store');
    return new StreamableFile(body, { type: CSV_CONTENT_TYPE, length: body.byteLength });
  }
}

/**
 * The usage-export module (x227). Registered in `app.module.ts` directly rather than folded into a
 * shared billing module, so it stays file-disjoint from the other billing slices; it wires its own
 * service on the globally-exported `TENANT_DATABASE`. It reuses `org.manage`, so it wires no
 * capability change.
 */
@Module({})
export class BillingUsageExportModule {
  static register(): DynamicModule {
    const service: Provider = {
      provide: USAGE_EXPORT_SERVICE,
      inject: [TENANT_DATABASE],
      useFactory: (database: TenantDatabase) => new UsageExportService(database),
    };

    return {
      module: BillingUsageExportModule,
      providers: [service],
      controllers: [UsageExportController],
    };
  }
}
