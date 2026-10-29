import { Controller, Get, Inject, Res, StreamableFile } from '@nestjs/common';
import type { Principal } from '@tmanage/domain';
import { Ctx, CurrentPrincipal, RequireCapability } from '../../common/http/decorators.js';
import { INSIGHTS_SERVICE } from '../../common/http/tokens.js';
import type { TenantContext } from '../../common/database/tenant-context.js';
import type { InsightsService, InsightsWorkloadView } from './insights.service.js';
import { toCsv } from './csv.js';

/** The header writer the download response needs — the narrow slice of the reply file-downloads uses. */
export interface CsvHeaderWriter {
  header(name: string, value: string): unknown;
}

const CSV_CONTENT_TYPE = 'text/csv; charset=utf-8';
const CSV_FILENAME = 'workload.csv';

/**
 * The CSV projection of the org-wide workload roll-up: a header row, one row per project (heaviest
 * first, in the order the service already sorts them), and the aggregate as a final row — the same
 * shape the Insights screen's workload table shows. Numbers are stringified by the writer; the
 * project id and the totals label pass through its RFC-4180 quoting and injection guard.
 */
export function workloadCsv(view: InsightsWorkloadView): string {
  const rows: (string | number)[][] = [['Project', 'Open items', 'Scheduled', 'People']];
  for (const project of view.projects) {
    rows.push([
      project.projectId,
      project.openItemCount,
      project.scheduledItemCount,
      project.assigneeCount,
    ]);
  }
  rows.push([
    `All projects (${view.totals.projectCount})`,
    view.totals.openItemCount,
    view.totals.scheduledItemCount,
    view.totals.assigneeCount,
  ]);
  return toCsv(rows);
}

/**
 * INS-05's export door — a read-only CSV download of the org-wide workload roll-up (x123).
 *
 * `GET …/insights/workload/export.csv`, behind `work.read` — the same internal-read capability the
 * `/workload` JSON read is gated on (reused, no capability-table or role-grid edit, no migration).
 * The route never mutates: it calls the very same tenant-scoped {@link InsightsService.orgWorkload}
 * the JSON read uses, so the tenant scope, the per-project relation check and the client-audience
 * narrowing are all inherited unchanged — a caller sees only the projects they may read, a
 * cross-tenant project never contributes, and a caller without the role is refused by the global
 * `CapabilityGuard` exactly as the JSON read is (the 403 the e2e chain proves).
 *
 * The body is returned as a {@link StreamableFile} so Nest stays in its own response mode — the
 * correlation and client-projection interceptors and the exception filter still shape everything
 * that is not the bytes — and the headers `file-downloads` uses for a safe download are written
 * here: the exact `text/csv` type, `attachment` disposition, `nosniff`, and a private, no-store
 * cache. A separate controller from the JSON reads for the one reason its response mode differs.
 */
@Controller('v1/organizations/:orgSlug/insights')
export class InsightsExportController {
  constructor(@Inject(INSIGHTS_SERVICE) private readonly insights: InsightsService) {}

  @Get('workload/export.csv')
  @RequireCapability('report.view')
  async exportWorkload(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Res({ passthrough: true }) reply: CsvHeaderWriter,
  ): Promise<StreamableFile> {
    const view = await this.insights.orgWorkload(context, principal);
    const body = Buffer.from(workloadCsv(view), 'utf8');

    reply.header('content-type', CSV_CONTENT_TYPE);
    reply.header('content-length', String(body.byteLength));
    reply.header('content-disposition', `attachment; filename="${CSV_FILENAME}"`);
    reply.header('x-content-type-options', 'nosniff');
    reply.header('cache-control', 'private, no-store');

    return new StreamableFile(body, { type: CSV_CONTENT_TYPE, length: body.byteLength });
  }
}
