import { authorize } from '@tmanage/domain';
import type { Principal } from '@tmanage/domain';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import { ProjectObjectivesRepository } from './project-objectives.repository.js';
import { KeyResultsRepository } from './key-results.repository.js';
import type { UpdateKeyResultInput } from './key-results.repository.js';
import type { ObjectiveKeyResultRow } from '../../common/database/schema.js';

/**
 * The application service for PROJ / module 8 (x207) — the key-result object-level decisions the route
 * guard cannot make. It follows the `ObjectiveWorkLinksService` shape (a child under an objective).
 *
 * ## The two authorization layers
 *
 * `CapabilityGuard` on the route asks the coarse question — `project.manage` (create/update) or
 * `work.read` (list): does this role's ceiling include the capability at all. This service adds the
 * **relation** check with the objective's project in hand: a member without organization-wide scope
 * reads and writes only the projects they belong to.
 *
 * ## The Known-trap order (FAST-PROTOCOL)
 *
 * Every route names an id — `objectiveId`, and on update the `keyResultId`. Each is resolved
 * **tenant- and project-scoped BEFORE the relation check and the write**: an unknown or another tenant's
 * id is a 404, never a foreign-key 500, and the relation failure is a 404 too (a 403 would confirm the
 * row exists to a caller who is not a member). On update, the key result must belong to the *objective*
 * named in the path, or it earns the same not-found.
 *
 * No audit event is written yet — like `ObjectiveWorkLinksService`, that is a follow-up (it needs a
 * `key_result.*` entry in the `AuditAction` catalog, out of this slice).
 */

/** What a caller is allowed to see of a key result. `organizationId` is deliberately absent. */
export interface KeyResultView {
  readonly id: string;
  readonly objectiveId: string;
  readonly title: string;
  readonly targetValue: number;
  readonly currentValue: number;
  readonly unit: string;
  /** Computed from `current / target` on read: an integer 0–100, bounded and div-by-zero safe. */
  readonly progressPercent: number;
  readonly createdBy: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/**
 * Progress as a whole-number percentage, computed rather than stored so it can never drift from the
 * values it derives from.
 *
 * - **Div-by-zero safe / target = 0 guarded:** a target of zero (or, defensively, a negative one) has
 *   no meaningful ratio, so progress is 0 rather than `Infinity`/`NaN`.
 * - **Bounded to 0–100:** a negative current floors at 0 and an over-achieving current caps at 100, so
 *   the value a progress bar renders is always in range.
 */
export function computeProgressPercent(currentValue: number, targetValue: number): number {
  if (!Number.isFinite(targetValue) || targetValue <= 0) return 0;
  if (!Number.isFinite(currentValue)) return 0;
  const raw = Math.round((currentValue / targetValue) * 100);
  return Math.max(0, Math.min(100, raw));
}

/**
 * An explicit projection, not a serialised row (`25-AUTH-AND-TENANT-ISOLATION` §7). Listing the fields
 * means a column added to `objective_key_results` later is invisible to every caller until someone
 * decides otherwise, and `organization_id` is never echoed into a response body.
 */
function toView(row: ObjectiveKeyResultRow): KeyResultView {
  return {
    id: row.id,
    objectiveId: row.objectiveId,
    title: row.title,
    targetValue: row.targetValue,
    currentValue: row.currentValue,
    unit: row.unit,
    progressPercent: computeProgressPercent(row.currentValue, row.targetValue),
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export class KeyResultsService {
  constructor(
    private readonly database: TenantDatabase,
    private readonly keyResults: KeyResultsRepository = new KeyResultsRepository(),
    private readonly objectives: ProjectObjectivesRepository = new ProjectObjectivesRepository(),
  ) {}

  /**
   * Resolve an objective the principal may act on under `capability`, tenant-scoped and relation-gated
   * on its project, or throw the not-found that both an unknown id and a non-member's probe must earn.
   */
  private async requireVisibleObjective(
    context: TenantContext,
    principal: Principal,
    objectiveId: string,
    capability: 'project.manage' | 'work.read',
  ): Promise<void> {
    const objective = await this.database.read(context, (runner) =>
      this.objectives.findById(runner, context, objectiveId),
    );
    if (!objective) {
      throw new ApiError(404, 'not_found', MESSAGES.notFound, undefined, 'objective_not_visible');
    }
    const permitted = authorize({
      principal,
      capability,
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
  }

  /**
   * List an objective's key results the principal may read, in creation order.
   *
   * The objective is resolved read-visible first (Known-trap): an unknown or cross-tenant `objectiveId`
   * and a non-member's probe both earn the same not-found. The tenant filter and the deterministic order
   * are the repository's.
   */
  async list(
    context: TenantContext,
    principal: Principal,
    options: { readonly objectiveId: string; readonly limit?: number },
  ): Promise<readonly KeyResultView[]> {
    await this.requireVisibleObjective(context, principal, options.objectiveId, 'work.read');

    const rows = await this.database.read(context, (runner) =>
      this.keyResults.list(runner, context, options),
    );
    return rows.map(toView);
  }

  /**
   * Create a key result under an objective the principal may manage.
   *
   * The objective is resolved manage-visible first (Known-trap): an unknown or cross-tenant `objectiveId`
   * is a 404, and a caller who names an objective they do not manage gets the same not-found rather than
   * a 403 that would confirm it exists. Then the write.
   */
  async create(
    context: TenantContext,
    principal: Principal,
    input: {
      readonly objectiveId: string;
      readonly title: string;
      readonly targetValue: number;
      readonly currentValue: number;
      readonly unit: string;
    },
  ): Promise<KeyResultView> {
    await this.requireVisibleObjective(context, principal, input.objectiveId, 'project.manage');

    const row = await this.database.transaction(context, (tx) =>
      this.keyResults.create(tx, context, {
        objectiveId: input.objectiveId,
        title: input.title,
        targetValue: input.targetValue,
        currentValue: input.currentValue,
        unit: input.unit,
        createdBy: context.userId,
      }),
    );
    return toView(row);
  }

  /**
   * Update a key result's body — the inline progress edit.
   *
   * BOTH ids are resolved tenant- and project-scoped BEFORE the write (Known-trap): the key result is
   * resolved inside the tenant and must belong to the *objective* named in the path (else the same
   * not-found), then the objective is resolved manage-visible (a non-manager's probe ⇒ 404). Only then
   * the write, which changes only the body columns the edit named (the `0087` trigger pins the rest).
   */
  async update(
    context: TenantContext,
    principal: Principal,
    objectiveId: string,
    keyResultId: string,
    input: UpdateKeyResultInput,
  ): Promise<KeyResultView> {
    const existing = await this.database.read(context, (runner) =>
      this.keyResults.findById(runner, context, keyResultId),
    );
    // The key result must exist in the tenant AND belong to the objective named in the path: a
    // key-result id under another objective is not this route's to edit, so it earns the same not-found.
    if (!existing || existing.objectiveId !== objectiveId) {
      throw new ApiError(404, 'not_found', MESSAGES.notFound, undefined, 'key_result_not_visible');
    }

    await this.requireVisibleObjective(context, principal, objectiveId, 'project.manage');

    const row = await this.database.transaction(context, (tx) =>
      this.keyResults.update(tx, context, keyResultId, input),
    );
    return toView(row);
  }
}
