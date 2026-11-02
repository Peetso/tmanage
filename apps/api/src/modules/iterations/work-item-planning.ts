import { isValidPointValue } from '@tmanage/domain';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';
import { ApiError } from '../../common/http/errors.js';
import { IterationsRepository } from './iterations.repository.js';

/**
 * 53-21 — the planning half of the work-item PATCH (`points`, `iterationId`), called by the work
 * service inside its update transaction after the row itself was written and `work.update` on it
 * was already decided. Kept here so the work module learns two fields, not the iteration rules.
 *
 * - `points`: `null` or a whole number 0..100, and only when the project has points switched on
 *   (else 422 `points_disabled`).
 * - `iterationId`: `null` (back to the backlog) or an open iteration of the item's project (else
 *   422 `invalid_iteration`).
 * - An item moved to another project needs no write here: every iteration read and the
 *   complete-and-roll count only the items of the iteration's own project.
 */

export interface WorkItemPlanningChange {
  readonly points?: number | null;
  readonly iterationId?: string | null;
}

export interface WorkItemPlanningResult {
  readonly points: number | null;
  readonly iterationId: string | null;
}

export type WorkItemPlanningRepository = Pick<
  IterationsRepository,
  'projectPoints' | 'findById' | 'findItems' | 'assignItems' | 'setPoints'
>;

const refuse = (code: string, field: string, message: string): ApiError =>
  new ApiError(422, 'validation_failed', message, [{ field, message: code }]);

/** Body parsing for the two fields; `undefined` = not sent. Pushes into the controller's details. */
export function parsePlanningFields(
  body: { readonly points?: unknown; readonly iterationId?: unknown } | undefined,
  details: { field: string; message: string }[],
): WorkItemPlanningChange {
  const out: { points?: number | null; iterationId?: string | null } = {};
  if (body?.points !== undefined) {
    if (body.points === null || isValidPointValue(body.points)) out.points = body.points;
    else details.push({ field: 'points', message: 'must be null or a whole number 0 to 100' });
  }
  if (body?.iterationId !== undefined) {
    const raw = body.iterationId;
    if (raw === null || (typeof raw === 'string' && raw.length > 0 && raw.length <= 64)) {
      out.iterationId = raw;
    } else details.push({ field: 'iterationId', message: 'must be an iteration id or null' });
  }
  return out;
}

export async function applyWorkItemPlanning(
  tx: TenantQueryRunner,
  context: TenantContext,
  item: { readonly id: string; readonly projectId: string },
  change: WorkItemPlanningChange,
  repo: WorkItemPlanningRepository = new IterationsRepository(),
): Promise<WorkItemPlanningResult | null> {
  if (change.points === undefined && change.iterationId === undefined) return null;
  if (change.points !== undefined && change.points !== null) {
    const project = await repo.projectPoints(tx, context, item.projectId);
    if (!project?.pointsEnabled) {
      throw refuse('points_disabled', 'points', 'Story points are switched off for this project');
    }
  }
  if (change.iterationId !== undefined && change.iterationId !== null) {
    const iteration = await repo.findById(tx, context, change.iterationId);
    if (!iteration || iteration.projectId !== item.projectId || iteration.status === 'completed') {
      throw refuse('invalid_iteration', 'iterationId', 'Pick an open iteration of this project');
    }
  }
  const current = (await repo.findItems(tx, context, [item.id]))[0];
  const iterationId =
    change.iterationId !== undefined ? change.iterationId : (current?.iterationId ?? null);
  if (iterationId !== (current?.iterationId ?? null)) {
    await repo.assignItems(tx, context, [item.id], iterationId, new Date());
  }
  if (change.points !== undefined) await repo.setPoints(tx, context, item.id, change.points);
  return {
    points: change.points !== undefined ? change.points : (current?.points ?? null),
    iterationId,
  };
}
