import { authorize } from '@tmanage/domain';
import type { Capability, Principal } from '@tmanage/domain';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import { OrgObjectivesRepository } from './org-objectives.repository.js';
import type { CreateOrgObjectiveInput, OrgObjectiveStatus } from './org-objectives.repository.js';
import type { OrgObjectiveRow } from '../../common/database/schema.js';

/**
 * The application service for PROJ / module 8 (x136) — the org-objective object-level decisions the
 * route guard cannot make. It follows the `ProjectObjectivesService` shape (x124), minus the project
 * resolution: an org objective belongs to the tenant, not to a project.
 *
 * ## The one authorization layer that matters here
 *
 * `CapabilityGuard` on the route asks the coarse question `project.manage` (write) / `work.read`
 * (read): does this role's ceiling include the capability at all. A role that does not hold it gets a
 * 403 there, before this service runs. This service re-checks the same decision with the **real**
 * `authorize()` evaluator (defence in depth), against an **org-level** resource (`projectId: null`).
 * Because the resource has no project, `authorize`'s relation gate (§12) does not apply: an org
 * objective is authorized on the role ceiling and the tenant, exactly as `25`'s "org-level resources
 * such as organization settings" are. A denial is an honest `403` — there is no project whose
 * existence a 404 would need to hide.
 *
 * ## The Known-trap order (FAST-PROTOCOL, 19:55)
 *
 * The PATCH route names `objectiveId` by id, and a cross-tenant or unknown id must never surface as a
 * foreign-key/500 or a silent no-op. So the id is resolved **tenant-scoped before the authorize check
 * and the write**: an unknown or another tenant's id is a `404`, never a `500`.
 *
 * No audit event is written yet — like `ProjectObjectivesService`, the audit action for an org
 * objective is a follow-up (it needs an `org_objective.*` entry in the `AuditAction` catalog, out of
 * this slice).
 */

/** What a caller is allowed to see of an org objective. `organizationId` is deliberately absent. */
export interface OrgObjectiveView {
  readonly id: string;
  readonly name: string;
  readonly description: string | null;
  readonly target: string | null;
  readonly status: OrgObjectiveStatus;
  readonly createdBy: string;
  readonly createdAt: string;
}

/**
 * An explicit projection, not a serialised row (`25-AUTH-AND-TENANT-ISOLATION` §7). Listing the
 * fields means a column added to `org_objectives` in a future migration is invisible to every caller
 * until someone decides otherwise. `organization_id` is never echoed into a response body.
 */
function toView(row: OrgObjectiveRow): OrgObjectiveView {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    target: row.target,
    status: row.status,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * The lifecycle: an objective is `open` at creation and closes to `met` or `missed`. A closed
 * objective is a dead end — it does not reopen and does not move to the other closed state. The only
 * legal transition is therefore `open → met | missed`.
 */
const CLOSING_STATUSES: ReadonlySet<OrgObjectiveStatus> = new Set(['met', 'missed']);

export class OrgObjectivesService {
  constructor(
    private readonly database: TenantDatabase,
    private readonly objectives: OrgObjectivesRepository = new OrgObjectivesRepository(),
  ) {}

  /**
   * Re-check `capability` against the org-level resource with the real evaluator, or throw the
   * ordinary `403`. Shared by every entry point. `projectId` is `null` — an org objective has no
   * project — so the relation gate never applies and the decision is the role ceiling and the tenant.
   */
  private authorizeOrg(context: TenantContext, principal: Principal, capability: Capability): void {
    const permitted = authorize({
      principal,
      capability,
      resource: {
        organizationId: context.organizationId,
        projectId: null,
        audience: 'internal',
        lifecycle: 'active',
      },
    }).allowed;
    if (!permitted) {
      throw new ApiError(403, 'forbidden', MESSAGES.forbidden, undefined, `denied_${capability}`);
    }
  }

  /**
   * List the organization's objectives the principal may read, in creation order.
   *
   * Gated on `work.read` at the org level; the tenant filter and the deterministic `created_at ASC`
   * order are the repository's.
   */
  async list(
    context: TenantContext,
    principal: Principal,
    options: { readonly limit?: number } = {},
  ): Promise<readonly OrgObjectiveView[]> {
    this.authorizeOrg(context, principal, 'work.read');

    const rows = await this.database.read(context, (runner) =>
      this.objectives.list(runner, context, options),
    );
    return rows.map(toView);
  }

  /**
   * Create an org objective the principal may manage.
   *
   * Gated on `project.manage` at the org level, then the write.
   */
  async create(
    context: TenantContext,
    principal: Principal,
    input: {
      readonly name: string;
      readonly description?: string | null;
      readonly target?: string | null;
      readonly status: OrgObjectiveStatus;
    },
  ): Promise<OrgObjectiveView> {
    this.authorizeOrg(context, principal, 'project.manage');

    const toWrite: CreateOrgObjectiveInput = {
      name: input.name,
      description: input.description ?? null,
      target: input.target ?? null,
      status: input.status,
      createdBy: context.userId,
    };

    const row = await this.database.transaction(context, (tx) =>
      this.objectives.create(tx, context, toWrite),
    );
    return toView(row);
  }

  /**
   * Transition an objective's status: `open → met | missed`, a guarded transition.
   *
   * The id is resolved tenant-scoped BEFORE the write (Known-trap): the objective is resolved inside
   * the tenant (unknown/cross-tenant ⇒ 404), then authorized on `project.manage` at the org level. The
   * state machine allows a transition only from `open`; transitioning an already-closed objective is an
   * illegal transition — a 409 with no write, not a silent no-op. On the allowed transition, `status`
   * is the only column written (the `0046` trigger pins every other), so who set the objective and its
   * wording stay as authored.
   */
  async transition(
    context: TenantContext,
    principal: Principal,
    objectiveId: string,
    status: OrgObjectiveStatus,
  ): Promise<OrgObjectiveView> {
    if (!CLOSING_STATUSES.has(status)) {
      // Defence in depth: the controller already rejects a body status that is not met|missed with a
      // 422, so this is only reachable if that check is removed. An objective is never set back to
      // open, so 'open' is not a transition target.
      throw new ApiError(
        422,
        'validation_failed',
        'An objective can only be transitioned to met or missed',
        [{ field: 'status', message: 'must be met or missed' }],
        'illegal_transition',
      );
    }

    const objective = await this.database.read(context, (runner) =>
      this.objectives.findById(runner, context, objectiveId),
    );
    if (!objective) {
      throw new ApiError(404, 'not_found', MESSAGES.notFound, undefined, 'objective_not_visible');
    }

    this.authorizeOrg(context, principal, 'project.manage');

    if (objective.status !== 'open') {
      throw new ApiError(
        409,
        'conflict',
        'An objective can only be transitioned while it is open',
        [
          {
            field: 'status',
            message: `cannot transition an objective that is ${objective.status}`,
          },
        ],
        'illegal_transition',
      );
    }

    const row = await this.database.transaction(context, (tx) =>
      this.objectives.updateStatus(tx, context, objectiveId, status),
    );
    return toView(row);
  }
}
