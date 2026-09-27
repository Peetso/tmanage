import { authorize } from '@tmanage/domain';
import type { Principal } from '@tmanage/domain';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { UsageCounterRow } from '../../common/database/schema.js';
import { UsageExportRepository } from './usage-export.repository.js';

/**
 * Billing & entitlements (module 19, x227). The usage-export service — the business layer over the
 * date-windowed usage CSV export. It follows the `usage-alerts.service` posture: it holds the
 * {@link TenantDatabase} and the repository, opens the read, and makes the authoritative
 * authorization decision. No driver handle lives here (the repository holds it), so this file is free
 * of the `no-restricted-imports` boundary that reserves `drizzle-orm` for repository/database modules.
 *
 * ## The capability
 *
 * Billing is an org-admin concern, so this reuses `org.manage` — no billing capability exists and this
 * slice adds none (the same divergence `usage-alerts.service.ts` records; no `capabilities.ts` edit).
 * The route guard asks the coarse ceiling question; this service adds the authoritative application
 * decision (`25-AUTH` §3 step 2, deny-by-default): an org-scoped `authorize()` (`projectId: null`) that
 * a suspended membership or a role without `org.manage` fails with a 403 before any read.
 *
 * ## The row cap
 *
 * `26-THREAT-MODELS` treats a bulk export as an egress sink. The read is bounded at
 * {@link USAGE_EXPORT_MAX_ROWS}: the repository is asked for the ceiling plus one, and a tenant that
 * somehow carries more counter rows than the ceiling is refused with a 413 rather than served an
 * unbounded table. The date-window validation and the CSV serialization are the controller's.
 */

/**
 * One row of the usage export — the wire projection of a `usage_counters` row. `organizationId`,
 * `id`, `version` and the optimistic-lock internals are deliberately absent: a caller sees the metric,
 * its used/reserved values, the current threshold band and the timestamps, and nothing that names the
 * tenant or the storage internals. Paired Exact with the web `UsageExportColumns` in the contracts gate.
 */
export interface UsageExportView {
  readonly metricKey: string;
  readonly usedValue: number;
  readonly reservedValue: number;
  readonly thresholdBand: number;
  /** The last reconciliation instant (ISO-8601), or `null` when the counter was never reconciled. */
  readonly reconciledAt: string | null;
  /** The last update instant, ISO-8601. The controller windows the export on this field. */
  readonly updatedAt: string;
}

/** The most rows one usage export may carry. Past it the request is refused with 413, never served. */
export const USAGE_EXPORT_MAX_ROWS = 10_000;

/** An explicit projection, not a serialised row: a column added later is invisible until named. */
function toView(row: UsageCounterRow): UsageExportView {
  return {
    metricKey: row.metricKey,
    usedValue: row.usedValue,
    reservedValue: row.reservedValue,
    thresholdBand: row.thresholdBand,
    reconciledAt: row.reconciledAt ? row.reconciledAt.toISOString() : null,
    updatedAt: row.updatedAt.toISOString(),
  };
}

export class UsageExportService {
  constructor(
    private readonly database: TenantDatabase,
    private readonly counters: UsageExportRepository = new UsageExportRepository(),
  ) {}

  /**
   * Read the acting tenant's usage counters for export, for an org admin. The capability decision is
   * made here (403), the read is tenant-scoped by the repository, and the row cap is enforced (413)
   * before any bytes are shaped. The date-window filter and the CSV serialization are the controller's.
   */
  async listForExport(
    context: TenantContext,
    principal: Principal,
  ): Promise<readonly UsageExportView[]> {
    this.requireOrgManage(principal, context, 'usage_export.list');
    const rows = await this.database.read(context, (runner) =>
      this.counters.listForExport(runner, context, USAGE_EXPORT_MAX_ROWS + 1),
    );
    if (rows.length > USAGE_EXPORT_MAX_ROWS) {
      throw new ApiError(
        413,
        'validation_failed',
        'The usage export is too large. Narrow the from/to window and try again',
        [{ field: 'export', message: `exceeds the ${USAGE_EXPORT_MAX_ROWS}-row export limit` }],
        'usage_export_row_cap',
      );
    }
    return rows.map(toView);
  }

  /** Org-scoped deny-by-default decision the route guard cannot make (membership status, etc.). */
  private requireOrgManage(principal: Principal, context: TenantContext, action: string): void {
    const verdict = authorize({
      principal,
      capability: 'org.manage',
      resource: {
        organizationId: context.organizationId,
        projectId: null,
        audience: 'internal',
        lifecycle: 'active',
      },
    });
    if (!verdict.allowed) {
      throw new ApiError(
        403,
        'forbidden',
        MESSAGES.forbidden,
        undefined,
        `${action}:${verdict.code}`,
      );
    }
  }
}
