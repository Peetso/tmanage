import type { Principal } from '@tmanage/domain';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import type { WorkItemsRepository } from '../work/work-items.repository.js';
import { mayTrackOnItem, mayTrackOnProject } from './time-capabilities.js';

/** What tracked time is for: a work item (with its project), only a project, or neither. */
export interface TimeTarget {
  readonly workItemId: string | null;
  readonly projectId: string | null;
}

export interface TimeTargetLookups {
  readonly workItems: Pick<WorkItemsRepository, 'findById'>;
  projectExists(
    runner: TenantQueryRunner,
    context: TenantContext,
    projectId: string,
  ): Promise<boolean>;
}

/**
 * 52-01 — resolve the work item or project time is tracked on, tenant-scoped, and check
 * `work.read` on it: a stranger's or another tenant's item or project is the same 404. Shared by
 * the running timer and automatic tracking's current task.
 */
export async function resolveTimeTarget(
  lookups: TimeTargetLookups,
  tx: TenantQueryRunner,
  context: TenantContext,
  principal: Principal,
  workItemId: string | null,
  projectId: string | null,
): Promise<TimeTarget> {
  if (workItemId !== null) {
    const item = await lookups.workItems.findById(tx, context, workItemId);
    if (!item || !mayTrackOnItem(principal, item)) {
      throw new ApiError(404, 'not_found', MESSAGES.notFound);
    }
    if (projectId !== null && projectId !== item.projectId) {
      throw new ApiError(400, 'validation_failed', 'The request body is invalid', [
        { field: 'projectId', message: 'must be the work item’s project' },
      ]);
    }
    return { workItemId: item.id, projectId: item.projectId };
  }
  if (projectId !== null) {
    if (
      !mayTrackOnProject(principal, context, projectId) ||
      !(await lookups.projectExists(tx, context, projectId))
    ) {
      throw new ApiError(404, 'not_found', MESSAGES.notFound);
    }
    return { workItemId: null, projectId };
  }
  return { workItemId: null, projectId: null };
}
