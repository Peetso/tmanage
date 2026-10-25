import { authorize, uuidv7 } from '@tmanage/domain';
import type { Principal } from '@tmanage/domain';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import { INSIGHT_SNAPSHOT_KINDS } from '../../common/database/schema.js';
import type { InsightSnapshotKind, InsightSnapshotRow } from '../../common/database/schema.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { InsightsService } from './insights.service.js';
import { emptyApprovalCycleMetrics } from './approval-cycle.repository.js';
import { InsightSnapshotsRepository } from './snapshots.repository.js';
import type { SnapshotProjectScope } from './snapshots.repository.js';

/**
 * x211's service — Insight snapshots (module 15, Insights & reporting).
 *
 * The audit's gap is plain: insights are live-only, so a studio can read today's numbers but has no
 * way to compare them against a stored moment over time. A snapshot closes it by freezing what one
 * org-level insights read returned — its `payload` stored whole — so the history screen can list
 * past captures and compare an older one against the latest ("current").
 *
 * ## What it computes, and what it stores
 *
 * Two report kinds are captured, both org-level reads that need no project id: `portfolio` (the
 * portfolio roll-up) and `workload` (the org-wide workload roll-up). Each is computed by reusing
 * {@link InsightsService} — the same code the live reads run, so a snapshot is exactly what the live
 * screen would have shown. The computed view is stored as the row's opaque JSON `payload`; a new
 * metric field never needs a schema change here.
 *
 * ## Capability and tenant scope
 *
 * Every operation is behind `work.read` (on the controller routes, and re-checked org-level there —
 * the internal-read capability the sibling insights reads reuse, so this slice needs no capability
 * table or role-grid edit). The service is the tenant-scoped data seam: every write binds
 * `organization_id` from the context (never from input), and every read filters on it, so a snapshot
 * can never be captured for, listed across, or fetched from another tenant. `capturedAt` is a `Date`
 * the service binds at capture time, NOT the connection clock (the admin-pool clock trap) — a
 * snapshot's instant is the moment its metrics were computed.
 */

/**
 * x211's read shape — one stored snapshot as the wire projection.
 *
 * `payload` is the computed metrics the read returned, kept opaque (`unknown`) at the boundary: the
 * consumer renders it as the metric it captured, and the column stays schema-stable. `capturedAt` is
 * the ISO instant the metrics were computed. Paired in `e2e/contracts/api-web-shapes.ts` with the web
 * shape the history screen consumes (CONTRACT-001).
 */
export interface SnapshotView {
  readonly id: string;
  readonly kind: InsightSnapshotKind;
  readonly capturedAt: string;
  readonly payload: unknown;
}

/** The default and hard ceiling for a snapshot-history page. A caller may ask for fewer, never more. */
const DEFAULT_LIST_LIMIT = 20;
const MAX_LIST_LIMIT = 50;

/** Clamp a requested page size into `[1, 50]`, default 20 — a list read is never an unbounded scan. */
function clampLimit(requested: number | undefined): number {
  if (requested === undefined || !Number.isFinite(requested)) return DEFAULT_LIST_LIMIT;
  return Math.max(1, Math.min(MAX_LIST_LIMIT, Math.trunc(requested)));
}

/**
 * Narrow an arbitrary string to a known report kind, or reject it as a 400. An unknown kind is never
 * a stored row and never a silently empty list — a caller cannot snapshot or query a metric that does
 * not exist.
 */
export function parseSnapshotKind(raw: string | undefined): InsightSnapshotKind {
  if (raw !== undefined && (INSIGHT_SNAPSHOT_KINDS as readonly string[]).includes(raw)) {
    return raw as InsightSnapshotKind;
  }
  throw new ApiError(400, 'validation_failed', 'The snapshot kind is invalid', [
    { field: 'kind', message: `must be one of: ${INSIGHT_SNAPSHOT_KINDS.join(', ')}` },
  ]);
}

export class InsightSnapshotsService {
  constructor(
    private readonly database: TenantDatabase,
    private readonly insights: InsightsService,
    private readonly repository: InsightSnapshotsRepository = new InsightSnapshotsRepository(),
  ) {}

  /**
   * Whether this principal may read the org's insights, judged by `work.read` against the
   * organization itself (`projectId: null`, internal audience) — the org-level relation half of the
   * capability the controller gated on the role, the same belt-and-braces {@link InsightsAdoptionController}
   * applies. A client is refused because `work.read` is internal-only, and a cross-tenant principal by
   * the tenant check inside `authorize`.
   */
  mayReadOrgInsights(principal: Principal, context: TenantContext): boolean {
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

  /**
   * Capture the current metrics for a report kind into a stored snapshot. The metrics are computed by
   * the live insights code (so the snapshot is exactly what the live screen would show), then written
   * in one transaction with a bound `capturedAt`. `organization_id` comes from the context; the id is
   * a UUIDv7 minted here.
   */
  async capture(
    context: TenantContext,
    principal: Principal,
    kind: InsightSnapshotKind,
  ): Promise<SnapshotView> {
    const capturedAt = new Date();
    const payload = await this.computeMetrics(context, principal, kind);
    const id = uuidv7();

    await this.database.transaction(context, (runner) =>
      this.repository.insert(runner, context, { id, kind, capturedAt, payload }),
    );

    return { id, kind, capturedAt: capturedAt.toISOString(), payload };
  }

  /**
   * List a tenant's snapshots of one kind, newest first, in a clamped page — the history the screen
   * lists and compares over. Tenant-scoped in SQL on `organization_id`, so another tenant's snapshots
   * are never returned.
   */
  async list(
    context: TenantContext,
    principal: Principal,
    kind: InsightSnapshotKind,
    options: { limit?: number } = {},
  ): Promise<readonly SnapshotView[]> {
    const limit = clampLimit(options.limit);
    const rows = await this.database.read(context, (runner) =>
      this.repository.list(runner, context, kind, limit),
    );
    const payloads = await scopeSnapshotPayloadsForReader(
      this.database,
      context,
      principal,
      rows.map((row) => ({ kind: row.kind, payload: row.payloadJson })),
      this.repository,
    );
    return rows.map((row, index) => toView(row, payloads[index]));
  }

  /**
   * Fetch one snapshot by id, tenant-scoped — the compare surface's read. A snapshot that does not
   * exist or belongs to another tenant is a 404, never a cross-tenant leak: the read filters on both
   * `organization_id` and `id`, the composite isolation key.
   */
  async getById(context: TenantContext, principal: Principal, id: string): Promise<SnapshotView> {
    const row = await this.database.read(context, (runner) =>
      this.repository.findById(runner, context, id),
    );
    if (!row) {
      throw new ApiError(404, 'not_found', MESSAGES.notFound, undefined, 'snapshot_not_found');
    }
    const [payload] = await scopeSnapshotPayloadsForReader(
      this.database,
      context,
      principal,
      [{ kind: row.kind, payload: row.payloadJson }],
      this.repository,
    );
    return toView(row, payload);
  }

  /** Compute the live metrics for a kind by reusing the insights reads the live screens run. */
  private async computeMetrics(
    context: TenantContext,
    principal: Principal,
    kind: InsightSnapshotKind,
  ): Promise<unknown> {
    switch (kind) {
      case 'portfolio':
        return this.insights.portfolio(context, principal);
      case 'workload':
        return this.insights.orgWorkload(context, principal);
    }
  }
}

/**
 * Project a stored row to the wire shape. `capturedAt` becomes an ISO string; `payload` is the
 * reader-scoped payload (F21), never the stored one unchanged.
 */
function toView(row: InsightSnapshotRow, payload: unknown): SnapshotView {
  return {
    id: row.id,
    kind: row.kind,
    capturedAt: row.capturedAt.toISOString(),
    payload,
  };
}

/**
 * F21 — a snapshot stores the view its *capturer* could see (an owner's capture names every project
 * in the tenant), and no capture scope is kept. So every read filters the stored payload for the
 * *reader*: each project entry is kept only when `authorize(work.read)` passes for the reader on that
 * project (resolved tenant-scoped now — a project gone since the capture is dropped), exactly the
 * rule the live portfolio and workload reads apply, and the counts are recomputed from what is kept.
 * A portfolio entry's approval figures are blanked unless the reader also passes `approval.read` on
 * that project, as the live portfolio does. Metric alerts evaluate against the same scoped totals.
 */
export async function scopeSnapshotPayloadsForReader(
  database: TenantDatabase,
  context: TenantContext,
  principal: Principal,
  entries: readonly { readonly kind: InsightSnapshotKind; readonly payload: unknown }[],
  repository: InsightSnapshotsRepository = new InsightSnapshotsRepository(),
): Promise<readonly unknown[]> {
  const ids = new Set<string>();
  for (const entry of entries) {
    for (const id of payloadProjectIds(entry.payload)) ids.add(id);
  }
  const scopes =
    ids.size === 0 || principal.kind !== 'internal'
      ? []
      : await database.read(context, (runner) =>
          repository.projectScopes(runner, context, [...ids]),
        );
  const byId = new Map(scopes.map((scope) => [scope.id, scope]));
  return entries.map((entry) => scopeSnapshotPayload(entry.kind, entry.payload, principal, byId));
}

/**
 * The pure half of {@link scopeSnapshotPayloadsForReader}: filter one stored payload for one reader
 * given the scope facts of the projects it names. An unexpected payload shape yields `null` (nothing
 * is shown rather than an unfiltered blob); a client principal keeps no project.
 */
export function scopeSnapshotPayload(
  kind: InsightSnapshotKind,
  payload: unknown,
  principal: Principal,
  scopes: ReadonlyMap<string, SnapshotProjectScope>,
): unknown {
  if (!isRecord(payload) || !Array.isArray(payload.projects)) return null;
  const entries = payload.projects.filter(isRecord);
  const kept: { readonly entry: PayloadRecord; readonly scope: SnapshotProjectScope }[] = [];
  for (const entry of entries) {
    const scope = typeof entry.projectId === 'string' ? scopes.get(entry.projectId) : undefined;
    if (scope !== undefined && readerMay(principal, scope, 'work.read'))
      kept.push({ entry, scope });
  }

  switch (kind) {
    case 'portfolio': {
      const projects = kept.map(({ entry, scope }) => {
        if (readerMay(principal, scope, 'approval.read')) return entry;
        const cycle = isRecord(entry.approvalCycle) ? entry.approvalCycle : {};
        return {
          ...entry,
          approvalCycle: {
            ...cycle,
            projectId: scope.id,
            metrics: emptyApprovalCycleMetrics(),
            approvalCount: 0,
          },
        };
      });
      return { ...payload, projects, projectCount: projects.length };
    }
    case 'workload': {
      const storedTotals = isRecord(payload.totals) ? payload.totals : {};
      const projects = kept.map(({ entry }) => entry);
      const dropped = projects.length !== entries.length;
      return {
        ...payload,
        projects,
        totals: {
          projectCount: projects.length,
          // Distinct assignees across projects cannot be recomputed without stored identities;
          // when a project was dropped, the largest kept project's count is the honest lower
          // bound, and it never carries a hidden project's people.
          assigneeCount: dropped
            ? Math.max(0, ...projects.map((entry) => numberOrZero(entry.assigneeCount)))
            : numberOrZero(storedTotals.assigneeCount),
          openItemCount: sum(projects.map((entry) => numberOrZero(entry.openItemCount))),
          scheduledItemCount: sum(projects.map((entry) => numberOrZero(entry.scheduledItemCount))),
        },
      };
    }
  }
}

/** Whether the reader may use `capability` on one project — the live insights reads' resource shape. */
function readerMay(
  principal: Principal,
  scope: SnapshotProjectScope,
  capability: 'work.read' | 'approval.read',
): boolean {
  if (principal.kind !== 'internal') return false;
  return authorize({
    principal,
    capability,
    resource: {
      organizationId: scope.organizationId,
      projectId: scope.id,
      audience: capability === 'work.read' ? 'internal' : 'client_visible',
      lifecycle: capability === 'work.read' && scope.archivedAt !== null ? 'archived' : 'active',
    },
  }).allowed;
}

function payloadProjectIds(payload: unknown): string[] {
  if (!isRecord(payload) || !Array.isArray(payload.projects)) return [];
  return payload.projects
    .filter(isRecord)
    .map((entry) => entry.projectId)
    .filter((id): id is string => typeof id === 'string');
}

/** The loose shape a stored payload (or one of its project entries) is read through. */
interface PayloadRecord {
  readonly projects?: unknown;
  readonly totals?: unknown;
  readonly projectId?: unknown;
  readonly approvalCycle?: unknown;
  readonly assigneeCount?: unknown;
  readonly openItemCount?: unknown;
  readonly scheduledItemCount?: unknown;
  readonly [key: string]: unknown;
}

function isRecord(value: unknown): value is PayloadRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function numberOrZero(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}
