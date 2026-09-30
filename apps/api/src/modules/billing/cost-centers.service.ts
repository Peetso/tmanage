import { authorize } from '@tmanage/domain';
import type { Principal } from '@tmanage/domain';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { BillingCostCenterRow } from '../../common/database/schema.js';
import { CostCentersRepository } from './cost-centers.repository.js';

/**
 * Billing & entitlements (module 19, x281). The cost-centers service — the business layer over billing
 * cost centers and their project assignments. It follows the `billing_usage_alerts` service posture: it
 * holds the {@link TenantDatabase} and the repository, opens the read/transaction, and makes the
 * authoritative authorization decision. No driver handle lives here.
 *
 * ## The capability
 *
 * Billing is an org-admin concern, so every method reuses `org.manage` — no billing capability exists
 * and this slice adds none. The route guard asks the coarse ceiling question; this service adds the
 * authoritative application decision (`25-AUTH` §3 step 2, deny-by-default): an org-scoped
 * `authorize()` (`projectId: null`) that a suspended membership fails.
 *
 * ## The Known-trap order
 *
 * The tenant comes from the context the guard resolved, never the body. On every path that names an id,
 * the cost center — and, for an assignment, the project — is resolved **tenant-scoped before**
 * authorize/write: a cross-tenant or missing id is a 404, never a foreign-key surprise. Validation
 * (empty code/name) is the controller's, done before this service is called; nothing here writes on an
 * invalid input.
 *
 * ## What it does, and what it cannot
 *
 * Definitions and assignments only. It stores no amount, meters nothing and charges nothing — grouping
 * usage/spend by cost center is a later slice.
 */

/**
 * What a caller is allowed to see of one cost center: its id, code, display name, and the ids of the
 * projects assigned to it. `organizationId` is deliberately absent — the wire projection never echoes
 * the tenant id.
 */
export interface CostCenterView {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly projectIds: readonly string[];
}

/** What the service's create accepts. `code`/`name` are already validated non-empty by the caller. */
export interface CreateCostCenterParams {
  readonly code: string;
  readonly name: string;
}

export class CostCentersService {
  constructor(
    private readonly database: TenantDatabase,
    private readonly costCenters: CostCentersRepository = new CostCentersRepository(),
  ) {}

  /** List the acting tenant's cost centers with their assigned project ids, code-ascending. */
  async list(context: TenantContext, principal: Principal): Promise<readonly CostCenterView[]> {
    this.requireOrgManage(principal, context, 'cost_center.list');
    const { defs, assignments } = await this.database.read(context, async (runner) => {
      const defRows = await this.costCenters.listDefs(runner, context);
      const assignmentRows = await this.costCenters.listAssignmentsForCodes(
        runner,
        context,
        defRows.map((row) => row.code),
      );
      return { defs: defRows, assignments: assignmentRows };
    });
    return toViews(defs, assignments);
  }

  /**
   * Create a cost-center definition. `org.manage` org-scoped (a 403 for a caller without it). A code
   * that already names a definition in this tenant is a 409 with no write; the caller has already
   * validated `code`/`name`, so nothing is written on an invalid input.
   */
  async create(
    context: TenantContext,
    principal: Principal,
    params: CreateCostCenterParams,
  ): Promise<CostCenterView> {
    this.requireOrgManage(principal, context, 'cost_center.create');
    const row = await this.database.transaction(context, async (tx) => {
      const existing = await this.costCenters.findDefByCode(tx, context, params.code);
      if (existing) {
        throw new ApiError(
          409,
          'conflict',
          'A cost center already exists for that code',
          [{ field: 'code', message: 'must be unique' }],
          'cost_center_code_conflict',
        );
      }
      return this.costCenters.createDef(tx, context, { code: params.code, name: params.name });
    });
    return { id: row.id, code: row.code, name: row.name ?? '', projectIds: [] };
  }

  /**
   * Delete a cost center — the definition and every assignment sharing its code. The definition is
   * resolved tenant-scoped **before** authorize/write: a cross-tenant or missing id is a 404.
   */
  async remove(context: TenantContext, principal: Principal, id: string): Promise<void> {
    const existing = await this.resolveDef(context, id);
    this.requireOrgManage(principal, context, 'cost_center.remove');
    await this.database.transaction(context, (tx) =>
      this.costCenters.removeByCode(tx, context, existing.id, existing.code),
    );
  }

  /**
   * Assign a project to a cost center. Both the cost center and the project are resolved tenant-scoped
   * **before** authorize/write: a cross-tenant or missing id (of either) is a 404 with no write.
   * Idempotent — a repeat assignment is not a second row. `org.manage` org-scoped besides.
   */
  async assignProject(
    context: TenantContext,
    principal: Principal,
    id: string,
    projectId: string,
  ): Promise<void> {
    const existing = await this.resolveDef(context, id);
    const projectFound = await this.database.read(context, (runner) =>
      this.costCenters.projectExists(runner, context, projectId),
    );
    if (!projectFound) {
      throw new ApiError(
        404,
        'not_found',
        MESSAGES.notFound,
        undefined,
        'cost_center_project_not_visible',
      );
    }
    this.requireOrgManage(principal, context, 'cost_center.assign');
    await this.database.transaction(context, (tx) =>
      this.costCenters.assign(tx, context, existing.code, projectId),
    );
  }

  /**
   * Remove a project assignment from a cost center. The cost center is resolved tenant-scoped
   * **before** authorize/write: a cross-tenant or missing id is a 404. Idempotent — an assignment that
   * is not present is still a success. `org.manage` org-scoped besides.
   */
  async unassignProject(
    context: TenantContext,
    principal: Principal,
    id: string,
    projectId: string,
  ): Promise<void> {
    const existing = await this.resolveDef(context, id);
    this.requireOrgManage(principal, context, 'cost_center.unassign');
    await this.database.transaction(context, (tx) =>
      this.costCenters.unassign(tx, context, existing.code, projectId),
    );
  }

  /** Resolve a cost-center definition tenant-scoped; a cross-tenant or missing id is a 404. */
  private async resolveDef(context: TenantContext, id: string): Promise<BillingCostCenterRow> {
    const existing = await this.database.read(context, (runner) =>
      this.costCenters.findDefById(runner, context, id),
    );
    if (!existing) {
      throw new ApiError(404, 'not_found', MESSAGES.notFound, undefined, 'cost_center_not_visible');
    }
    return existing;
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

/** Build the wire views: each definition paired with the ids of the projects assigned to its code. */
function toViews(
  defs: readonly BillingCostCenterRow[],
  assignments: readonly BillingCostCenterRow[],
): readonly CostCenterView[] {
  const byCode = new Map<string, string[]>();
  for (const row of assignments) {
    if (row.projectId === null) continue;
    const list = byCode.get(row.code) ?? [];
    list.push(row.projectId);
    byCode.set(row.code, list);
  }
  return defs.map((row) => ({
    id: row.id,
    code: row.code,
    name: row.name ?? '',
    projectIds: byCode.get(row.code) ?? [],
  }));
}
