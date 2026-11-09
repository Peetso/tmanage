import { authorize } from '@tmanage/domain';
import type { Capability, Principal } from '@tmanage/domain';
import type { TenantContext } from '../../common/database/tenant-context.js';
import type { WorkItemRow } from '../../common/database/schema.js';
import { ApiError, MESSAGES } from '../../common/http/errors.js';

/**
 * 52-01 — capability stand-ins for time tracking.
 *
 * The `time.*` keys (`time.track`, `time.view_team`, `time.edit_any`) are a later registry slice:
 * appending to `CAPABILITIES` moves the custom-role mask and the 56-length assertions, and P6-B
 * owns `capabilities.ts` this pass. Until then:
 *
 * - **track own** ({@link TIME_TRACK_OWN}) = `work.read`, checked against the work item or project
 *   the time is for (the viewer's own relation), plus {@link requireInternal}: a client principal
 *   never tracks time.
 * - **team view / edit any** ({@link TIME_MANAGE_ANY}) = `project.manage`.
 *
 * Swap the two constants (and the controller decorators) when the `time.*` keys land.
 */
export const TIME_TRACK_OWN: Capability = 'work.read';
export const TIME_MANAGE_ANY: Capability = 'project.manage';
/** FIX-2026-11-10: the team time view (everyone's live state, task and time). */
export const TIME_VIEW_TEAM: Capability = 'time.view_team';

/** Time is internal: a client (or service) principal is refused before anything is read. */
export function requireInternal(principal: Principal): void {
  if (principal.kind !== 'internal') {
    throw new ApiError(403, 'forbidden', MESSAGES.forbidden, undefined, 'time.internal_only');
  }
}

/** May this principal track time on (and read) this work item? */
export function mayTrackOnItem(principal: Principal, row: WorkItemRow): boolean {
  if (row.deletedAt !== null) return false;
  return authorize({
    principal,
    capability: TIME_TRACK_OWN,
    resource: {
      organizationId: row.organizationId,
      projectId: row.projectId,
      audience: row.audience,
      lifecycle: row.state === 'archived' ? 'archived' : 'active',
    },
  }).allowed;
}

/** May this principal track time on (and read) this project? */
export function mayTrackOnProject(
  principal: Principal,
  context: TenantContext,
  projectId: string,
): boolean {
  return authorize({
    principal,
    capability: TIME_TRACK_OWN,
    resource: {
      organizationId: context.organizationId,
      projectId,
      audience: 'internal',
      lifecycle: 'active',
    },
  }).allowed;
}
