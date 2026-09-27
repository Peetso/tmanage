import { authorize } from '@tmanage/domain';
import type { Principal } from '@tmanage/domain';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import { ProjectRiskRegisterRepository } from './risk-register.repository.js';
import type {
  CreateProjectInternalRiskInput,
  ProjectInternalRiskImpact,
  ProjectInternalRiskLikelihood,
  ProjectInternalRiskStatus,
  UpdateProjectInternalRiskInput,
} from './risk-register.repository.js';
import { ProjectsRepository } from './projects.repository.js';
import type { ProjectInternalRiskRow } from '../../common/database/schema.js';

/**
 * The application service for PROJ / module 8 (x209) — the internal risk register's object-level
 * decisions. It follows the `ProjectObjectivesService` shape.
 *
 * ## The two authorization layers
 *
 * `CapabilityGuard` on the route asks the coarse question `project.manage` (write) / `work.read`
 * (read). This service adds the **relation** check with the row's project in hand — a member without
 * organization-wide scope reads and writes only the projects they belong to.
 *
 * ## The Known-trap order
 *
 * Every route names `projectId` (and, on PATCH, `riskId`) by id, and the composite foreign key would
 * surface an unknown or cross-tenant id as a foreign-key 500 the `HttpExceptionFilter` cannot map. So
 * every id the request names is resolved **tenant-scoped before the relation check and the write**:
 * an unknown or another tenant's id is a 404, never a 500, and the relation failure is a 404 too (a
 * 403 would confirm the row exists to a caller who is not a member).
 *
 * ## Severity is computed, never stored
 *
 * The register is a risk matrix: `severity` is `likelihood` × `impact`, computed here. There is no
 * `severity` column, so it cannot drift from the matrix. This is distinct from x140's `project_risks`,
 * which stores a client-facing `severity` flag and publishes it to a portal — this register is never
 * projected to a client.
 */

/** The computed matrix band. `low | medium | high`, derived from likelihood × impact. */
export type ProjectInternalRiskSeverity = 'low' | 'medium' | 'high';

/** What a caller is allowed to see of a risk. `organizationId` is deliberately absent. */
export interface ProjectInternalRiskView {
  readonly id: string;
  readonly projectId: string;
  readonly title: string;
  readonly likelihood: ProjectInternalRiskLikelihood;
  readonly impact: ProjectInternalRiskImpact;
  /** Computed from `likelihood` × `impact`; not a stored column. */
  readonly severity: ProjectInternalRiskSeverity;
  readonly mitigation: string | null;
  readonly status: ProjectInternalRiskStatus;
  readonly createdBy: string;
  readonly createdAt: string;
}

/** The three-point scale as a score, so the matrix product is a single number. */
const AXIS_SCORE: Readonly<Record<'low' | 'medium' | 'high', number>> = {
  low: 1,
  medium: 2,
  high: 3,
};

/**
 * The risk matrix: severity is the product of the two axes (1..9). `≤ 2` is low (both axes weak),
 * `≤ 4` is medium, and anything above is high (at least one axis high against a non-trivial other).
 * This is a deterministic function of the two enums, so the view can never disagree with the matrix.
 */
export function computeSeverity(
  likelihood: ProjectInternalRiskLikelihood,
  impact: ProjectInternalRiskImpact,
): ProjectInternalRiskSeverity {
  const score = AXIS_SCORE[likelihood] * AXIS_SCORE[impact];
  if (score <= 2) return 'low';
  if (score <= 4) return 'medium';
  return 'high';
}

/**
 * An explicit projection, not a serialised row (`25-AUTH-AND-TENANT-ISOLATION` §7). `organization_id`
 * is never echoed into a response body; `severity` is added, computed from the two axes.
 */
function toView(row: ProjectInternalRiskRow): ProjectInternalRiskView {
  return {
    id: row.id,
    projectId: row.projectId,
    title: row.title,
    likelihood: row.likelihood,
    impact: row.impact,
    severity: computeSeverity(row.likelihood, row.impact),
    mitigation: row.mitigation,
    status: row.status,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
  };
}

export class ProjectRiskRegisterService {
  constructor(
    private readonly database: TenantDatabase,
    private readonly risks: ProjectRiskRegisterRepository = new ProjectRiskRegisterRepository(),
    /**
     * Read-only, used to prove the project a new risk names exists **inside this tenant** before the
     * insert is attempted. The composite foreign key already refuses another tenant's project, but it
     * surfaces as a 500; an organization-wide caller skips the relation gate, so without this
     * pre-resolution a missing or cross-tenant `projectId` would fall through to that foreign key.
     */
    private readonly projects: ProjectsRepository = new ProjectsRepository(),
  ) {}

  /**
   * Resolve a project the principal may act on under `capability`, tenant- and relation-scoped, or
   * throw the not-found that both an unknown id and a non-member's probe must earn.
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
   * List a project's risks the principal may read, in creation order.
   *
   * The project is resolved read-visible first (Known-trap): an unknown or cross-tenant `projectId`,
   * and a non-member's probe, both earn the same not-found.
   */
  async list(
    context: TenantContext,
    principal: Principal,
    options: { readonly projectId: string; readonly limit?: number },
  ): Promise<readonly ProjectInternalRiskView[]> {
    await this.requireVisibleProject(context, principal, options.projectId, 'work.read');

    const rows = await this.database.read(context, (runner) =>
      this.risks.list(runner, context, options),
    );
    return rows.map(toView);
  }

  /**
   * Log a risk against a project the principal may manage.
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
      readonly title: string;
      readonly likelihood: ProjectInternalRiskLikelihood;
      readonly impact: ProjectInternalRiskImpact;
      readonly mitigation?: string | null;
      readonly status: ProjectInternalRiskStatus;
    },
  ): Promise<ProjectInternalRiskView> {
    await this.requireVisibleProject(context, principal, input.projectId, 'project.manage');

    const toWrite: CreateProjectInternalRiskInput = {
      projectId: input.projectId,
      title: input.title,
      likelihood: input.likelihood,
      impact: input.impact,
      mitigation: input.mitigation ?? null,
      status: input.status,
      createdBy: context.userId,
    };

    const row = await this.database.transaction(context, (tx) =>
      this.risks.create(tx, context, toWrite),
    );
    return toView(row);
  }

  /**
   * Update a risk's substance in a project the principal may manage.
   *
   * The risk id is resolved tenant-scoped BEFORE the write (Known-trap): an unknown or cross-tenant
   * `riskId` is a 404. Then the risk is relation-gated on its own project with `project.manage` — a
   * non-manager's probe earns the same not-found. Then the write, which the 0088 trigger confines to
   * the substance columns.
   */
  async update(
    context: TenantContext,
    principal: Principal,
    riskId: string,
    input: UpdateProjectInternalRiskInput,
  ): Promise<ProjectInternalRiskView> {
    const risk = await this.database.read(context, (runner) =>
      this.risks.findById(runner, context, riskId),
    );
    if (!risk) {
      throw new ApiError(404, 'not_found', MESSAGES.notFound, undefined, 'risk_not_visible');
    }
    const permitted = authorize({
      principal,
      capability: 'project.manage',
      resource: {
        organizationId: risk.organizationId,
        projectId: risk.projectId,
        audience: 'internal',
        lifecycle: 'active',
      },
    }).allowed;
    if (!permitted) {
      throw new ApiError(404, 'not_found', MESSAGES.notFound, undefined, 'risk_not_visible');
    }

    const row = await this.database.transaction(context, (tx) =>
      this.risks.update(tx, context, riskId, input),
    );
    return toView(row);
  }
}
