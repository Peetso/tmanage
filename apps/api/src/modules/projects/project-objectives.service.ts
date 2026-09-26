import { authorize } from '@tmanage/domain';
import type { Principal } from '@tmanage/domain';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import { ProjectObjectivesRepository } from './project-objectives.repository.js';
import type {
  CreateProjectObjectiveInput,
  ProjectObjectiveStatus,
} from './project-objectives.repository.js';
import { ProjectsRepository } from './projects.repository.js';
import type { ProjectObjectiveRow } from '../../common/database/schema.js';

/**
 * The application service for PROJ / module 8 (x124) — the project-objective object-level decisions
 * the route guard cannot make. It follows the `DecisionsService` shape.
 *
 * ## The two authorization layers
 *
 * `CapabilityGuard` on the route asks the coarse question `project.manage` (write) / `work.read`
 * (read): does this role's ceiling include the capability at all. A role that does not hold it gets a
 * 403 there, before this service runs. This service adds the **relation** check with the row's
 * project in hand — a member without organization-wide scope reads and writes only the projects they
 * belong to. `project.manage` and `work.read` are both relation-gated (`packages/domain`), so
 * `authorize()` does the membership check.
 *
 * ## The Known-trap order (FAST-PROTOCOL, 19:55)
 *
 * Every route names `projectId` (and, on PATCH, `objectiveId`) by id, and the composite foreign key
 * would surface an unknown or cross-tenant id as a foreign-key 500 the `HttpExceptionFilter` cannot
 * map. So every id the request names is resolved **tenant-scoped before the relation check and the
 * write**: an unknown or another tenant's id is a 404, never a 500, and the relation failure is a 404
 * too (a 403 would confirm the row exists to a caller who is not a member).
 *
 * No audit event is written yet — like `DecisionsService`, the audit action for an objective is a
 * follow-up (it needs a `project_objective.*` entry in the `AuditAction` catalog, out of this slice).
 */

/** What a caller is allowed to see of an objective. `organizationId` is deliberately absent. */
export interface ProjectObjectiveView {
  readonly id: string;
  readonly projectId: string;
  readonly name: string;
  readonly description: string | null;
  readonly target: string | null;
  readonly status: ProjectObjectiveStatus;
  readonly createdBy: string;
  readonly createdAt: string;
}

/**
 * An explicit projection, not a serialised row (`25-AUTH-AND-TENANT-ISOLATION` §7). Listing the
 * fields means a column added to `project_objectives` in a future migration is invisible to every
 * caller until someone decides otherwise. `organization_id` is never echoed into a response body.
 */
function toView(row: ProjectObjectiveRow): ProjectObjectiveView {
  return {
    id: row.id,
    projectId: row.projectId,
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
const CLOSING_STATUSES: ReadonlySet<ProjectObjectiveStatus> = new Set(['met', 'missed']);

export class ProjectObjectivesService {
  constructor(
    private readonly database: TenantDatabase,
    private readonly objectives: ProjectObjectivesRepository = new ProjectObjectivesRepository(),
    /**
     * Read-only, used to prove the project a new objective names exists **inside this tenant** before
     * the insert is attempted, exactly as `DecisionsService` does. The composite foreign key already
     * refuses another tenant's project, but it surfaces as a 500; an organization-wide caller skips
     * the relation gate, so without this pre-resolution a missing or cross-tenant `projectId` would
     * fall through to that foreign key.
     */
    private readonly projects: ProjectsRepository = new ProjectsRepository(),
  ) {}

  /**
   * Resolve a project the principal may act on under `capability`, tenant- and relation-scoped, or
   * throw the not-found that both an unknown id and a non-member's probe must earn. Shared by
   * {@link create} and {@link list}: both name a project by id in the path and must resolve it the
   * same way before anything else (Known-trap).
   */
  private async requireVisibleProject(
    context: TenantContext,
    principal: Principal,
    projectId: string,
    capability: 'project.manage' | 'work.read',
  ): Promise<void> {
    const project = await this.database.read(context, (runner) =>
      this.projects.findById(runner, context, projectId),
    );
    if (!project) {
      throw new ApiError(404, 'not_found', MESSAGES.notFound, undefined, 'project_not_visible');
    }
    const permitted = authorize({
      principal,
      capability,
      resource: {
        organizationId: context.organizationId,
        projectId,
        audience: 'internal',
        lifecycle: 'active',
      },
    }).allowed;
    if (!permitted) {
      throw new ApiError(404, 'not_found', MESSAGES.notFound, undefined, 'project_not_visible');
    }
  }

  /**
   * List a project's objectives the principal may read, in creation order.
   *
   * The project is resolved read-visible first (Known-trap): an unknown or cross-tenant `projectId`,
   * and a non-member's probe, both earn the same not-found. The tenant filter and the deterministic
   * `created_at ASC` order are the repository's.
   */
  async list(
    context: TenantContext,
    principal: Principal,
    options: { readonly projectId: string; readonly limit?: number },
  ): Promise<readonly ProjectObjectiveView[]> {
    await this.requireVisibleProject(context, principal, options.projectId, 'work.read');

    const rows = await this.database.read(context, (runner) =>
      this.objectives.list(runner, context, options),
    );
    return rows.map(toView);
  }

  /**
   * Create an objective in a project the principal may manage.
   *
   * The project is resolved manage-visible first (Known-trap): an unknown or cross-tenant `projectId`
   * is a 404, and a caller who names a project they do not manage gets the same not-found rather than
   * a 403 that would confirm the project exists. Then the write.
   */
  async create(
    context: TenantContext,
    principal: Principal,
    input: {
      readonly projectId: string;
      readonly name: string;
      readonly description?: string | null;
      readonly target?: string | null;
      readonly status: ProjectObjectiveStatus;
    },
  ): Promise<ProjectObjectiveView> {
    await this.requireVisibleProject(context, principal, input.projectId, 'project.manage');

    const toWrite: CreateProjectObjectiveInput = {
      projectId: input.projectId,
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
   * Both ids are resolved tenant- and project-scoped BEFORE the write (Known-trap): the objective is
   * resolved inside the tenant (unknown/cross-tenant ⇒ 404), then relation-gated on its own project
   * with `project.manage` (a non-manager's probe ⇒ 404). The state machine allows a transition only
   * from `open`; transitioning an already-closed objective is an illegal transition — a 409 with no
   * write, not a silent no-op. On the allowed transition, `status` is the only column written (the
   * `0040` trigger pins every other), so who set the objective and its wording stay as authored.
   */
  async transition(
    context: TenantContext,
    principal: Principal,
    objectiveId: string,
    status: ProjectObjectiveStatus,
  ): Promise<ProjectObjectiveView> {
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
    const permitted = authorize({
      principal,
      capability: 'project.manage',
      resource: {
        organizationId: objective.organizationId,
        projectId: objective.projectId,
        audience: 'internal',
        lifecycle: 'active',
      },
    }).allowed;
    if (!permitted) {
      throw new ApiError(404, 'not_found', MESSAGES.notFound, undefined, 'objective_not_visible');
    }

    if (objective.status !== 'open') {
      throw new ApiError(
        409,
        'conflict',
        'An objective can only be transitioned while it is open',
        [{ field: 'status', message: `cannot transition an objective that is ${objective.status}` }],
        'illegal_transition',
      );
    }

    const row = await this.database.transaction(context, (tx) =>
      this.objectives.updateStatus(tx, context, objectiveId, status),
    );
    return toView(row);
  }
}
