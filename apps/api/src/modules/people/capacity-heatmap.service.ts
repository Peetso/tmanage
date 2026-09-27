import { authorize } from '@tmanage/domain';
import type { Principal } from '@tmanage/domain';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { PersonAllocationRow, PersonCapacityRow } from '../../common/database/schema.js';
import type { CapacityHeatmapRepository } from './capacity-heatmap.repository.js';

/**
 * Team capacity heatmap (module 14, x193). A read-only, org-level roll-up that turns the two
 * per-person facts x170/x171 own — weekly capacity and project allocations — into a member × week
 * grid of utilisation, the view the per-person screens never gave.
 *
 * ## Deterministic, no new state
 *
 * The projection is arithmetic, not a model, and adds no table. For each week bucket in the requested
 * window a member's **allocated percent** is the sum of the `percent` of every allocation whose
 * `[start_date, end_date]` window overlaps that week; **capacity hours** is the member's `weekly_hours`
 * once its `effective_from` has been reached (0 before). **Allocated hours** is `capacityHours ×
 * allocatedPercent / 100`, and **utilisation** is `allocatedPercent / 100` — null when the member has
 * no capacity to divide by. A member is over-allocated in a week when the allocated percent exceeds
 * 100. Same input, same output, every time.
 *
 * ## Capability, scope and the Known-trap
 *
 * Behind `work.read` on the route (the internal-read capability the people directory reuses — no
 * capability table edit, no migration). This service adds the authoritative org-scoped `authorize()`
 * the route guard cannot make (deny-by-default, `25-AUTH` §3): a client principal, who never holds the
 * internal-only `work.read`, is a 403. Every read is tenant-scoped in the repository, and the window is
 * validated and bounded before any read, so an absurd range is a 400 rather than an unbounded scan.
 */

/** One member's utilisation in one week bucket. Nested in {@link CapacityHeatmapView}. */
export interface CapacityHeatmapCell {
  /** The Monday-agnostic start of the week bucket, an ISO-8601 date `YYYY-MM-DD`. */
  readonly weekStart: string;
  /** Sum of overlapping allocation percents for the member in this week. */
  readonly allocatedPercent: number;
  /** The member's weekly capacity in hours in this week (0 before `effective_from`). */
  readonly capacityHours: number;
  /** `capacityHours × allocatedPercent / 100`, rounded to two decimals. */
  readonly allocatedHours: number;
  /** `allocatedPercent / 100`, rounded to four decimals; null when there is no capacity. */
  readonly utilisation: number | null;
  /** True when the allocated percent exceeds 100 — the member is over-committed this week. */
  readonly overAllocated: boolean;
}

/** One member's row across the whole window. Nested in {@link CapacityHeatmapView}. */
export interface CapacityHeatmapMember {
  readonly membershipId: string;
  readonly cells: readonly CapacityHeatmapCell[];
}

/**
 * The team capacity heatmap — paired Exact with the web `CapacityHeatmapView`. No `organizationId`
 * anywhere: the wire projection never echoes the tenant id.
 */
export interface CapacityHeatmapView {
  /** The first week's start date, an ISO-8601 date `YYYY-MM-DD`. */
  readonly from: string;
  /** The number of week buckets in the window. */
  readonly weeks: number;
  /** The start date of each week bucket, in order — the heatmap's column headers. */
  readonly weekStarts: readonly string[];
  /** One row per member with capacity or an overlapping allocation in the window. */
  readonly members: readonly CapacityHeatmapMember[];
}

export interface CapacityHeatmapQuery {
  readonly from: string;
  readonly weeks: number;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const MS_PER_DAY = 24 * 60 * 60 * 1000;
export const MAX_WEEKS = 26;

/** Add whole days to an ISO date string, returning an ISO date string (UTC, no time zone drift). */
function addDays(isoDate: string, days: number): string {
  const at = new Date(`${isoDate}T00:00:00.000Z`).getTime() + days * MS_PER_DAY;
  return new Date(at).toISOString().slice(0, 10);
}

function round(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

/**
 * Validate the requested window. `from` must be an ISO date; `weeks` an integer in [1, {@link
 * MAX_WEEKS}]. An absurd or malformed range is a 400 before any read (the Known-trap bound).
 */
export function parseHeatmapQuery(fromRaw: unknown, weeksRaw: unknown): CapacityHeatmapQuery {
  if (typeof fromRaw !== 'string' || !ISO_DATE.test(fromRaw) || Number.isNaN(Date.parse(fromRaw))) {
    throw new ApiError(400, 'validation_failed', 'from is invalid', [
      { field: 'from', message: 'must be an ISO-8601 date (YYYY-MM-DD)' },
    ]);
  }
  const weeks = typeof weeksRaw === 'number' ? weeksRaw : Number(weeksRaw);
  if (!Number.isInteger(weeks) || weeks < 1 || weeks > MAX_WEEKS) {
    throw new ApiError(400, 'validation_failed', 'weeks is invalid', [
      { field: 'weeks', message: `must be an integer between 1 and ${MAX_WEEKS}` },
    ]);
  }
  return { from: fromRaw, weeks };
}

export class CapacityHeatmapService {
  constructor(
    private readonly database: TenantDatabase,
    private readonly repository: CapacityHeatmapRepository,
  ) {}

  /** Build the heatmap for the acting tenant over the validated window. */
  async build(
    context: TenantContext,
    principal: Principal,
    query: CapacityHeatmapQuery,
  ): Promise<CapacityHeatmapView> {
    if (!this.mayReadOrg(principal, context)) {
      throw new ApiError(403, 'forbidden', MESSAGES.forbidden, undefined, 'heatmap_read_denied');
    }

    const weekStarts = Array.from({ length: query.weeks }, (_, i) => addDays(query.from, i * 7));
    const windowEnd = addDays(query.from, query.weeks * 7 - 1);

    const { capacity, allocations } = await this.database.read(context, async (runner) => ({
      capacity: await this.repository.listCapacity(runner, context),
      allocations: await this.repository.listAllocationsInWindow(
        runner,
        context,
        query.from,
        windowEnd,
      ),
    }));

    const members = buildMembers(weekStarts, capacity, allocations);
    return { from: query.from, weeks: query.weeks, weekStarts, members };
  }

  /** Org-scoped deny-by-default read decision the route guard cannot make. */
  private mayReadOrg(principal: Principal, context: TenantContext): boolean {
    return authorize({
      principal,
      capability: 'work.read',
      resource: {
        organizationId: context.organizationId,
        projectId: null,
        audience: 'internal',
        lifecycle: 'active',
      },
    }).allowed;
  }
}

/**
 * The pure fold, exported for the unit proof: capacity + allocation rows → the member rows. Members
 * are the union of everyone with a capacity row or an overlapping allocation, ordered by membership id
 * so the grid is deterministic. No `organization_id` reaches the output.
 */
export function buildMembers(
  weekStarts: readonly string[],
  capacity: readonly PersonCapacityRow[],
  allocations: readonly PersonAllocationRow[],
): readonly CapacityHeatmapMember[] {
  const capacityByMember = new Map<string, PersonCapacityRow>();
  for (const row of capacity) capacityByMember.set(row.membershipId, row);

  const allocationsByMember = new Map<string, PersonAllocationRow[]>();
  for (const row of allocations) {
    const list = allocationsByMember.get(row.membershipId) ?? [];
    list.push(row);
    allocationsByMember.set(row.membershipId, list);
  }

  const membershipIds = [
    ...new Set<string>([...capacityByMember.keys(), ...allocationsByMember.keys()]),
  ].sort();

  return membershipIds.map((membershipId) => {
    const cap = capacityByMember.get(membershipId) ?? null;
    const rows = allocationsByMember.get(membershipId) ?? [];
    const cells = weekStarts.map((weekStart) => cell(weekStart, cap, rows));
    return { membershipId, cells };
  });
}

function cell(
  weekStart: string,
  cap: PersonCapacityRow | null,
  rows: readonly PersonAllocationRow[],
): CapacityHeatmapCell {
  const weekEnd = addDays(weekStart, 6);
  let allocatedPercent = 0;
  for (const row of rows) {
    const startsBy = row.startDate === null || row.startDate <= weekEnd;
    const endsAfter = row.endDate === null || row.endDate >= weekStart;
    if (startsBy && endsAfter) allocatedPercent += row.percent;
  }

  const capacityHours = cap !== null && cap.effectiveFrom <= weekEnd ? cap.weeklyHours : 0;
  const allocatedHours = round((capacityHours * allocatedPercent) / 100, 2);
  const utilisation = capacityHours > 0 ? round(allocatedPercent / 100, 4) : null;

  return {
    weekStart,
    allocatedPercent,
    capacityHours,
    allocatedHours,
    utilisation,
    overAllocated: allocatedPercent > 100,
  };
}
