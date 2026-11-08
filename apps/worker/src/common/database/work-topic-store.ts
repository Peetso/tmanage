import type { WorkerTransaction } from './worker-database.js';
import {
  CUSTOM_ROLE_COLUMNS,
  customRoleJoin,
  internalPrincipalRole,
  roleHolds,
} from './principal-role.js';
import type { CustomRoleColumns } from './principal-role.js';
import type { SubscriptionVerdict } from './realtime-store.js';

/**
 * 53-01 — the work topics a realtime socket may subscribe to, beside channels and DMs.
 *
 * - `project:<projectId>` — the project's work events (created, moved, edited, commented,
 *   people assigned). Allowed on current rows exactly as the HTTP read is: an active internal
 *   membership whose role holds `work.read`, and org-wide scope or a `project_memberships` row on
 *   that project (`authorize()` rule 12). The project must exist in the ticket's organization.
 * - `me` — the subscriber's own work, for My Day. The hub key is `user:<the ticket's user>`, so a
 *   socket can never name somebody else's personal topic; it needs the same active membership
 *   and `work.read`.
 *
 * Frames are ids only (event type, work item id, project id); the client refetches through its
 * authorized reads. A refusal is the module's opaque `REFUSED`.
 */

export const MY_WORK_TOPIC = 'me';
const PROJECT_PREFIX = 'project:';
const USER_PREFIX = 'user:';
const REFUSED: SubscriptionVerdict = { allowed: false, cursor: 0 };
const ALLOWED: SubscriptionVerdict = { allowed: true, cursor: 0 };
const ID = /^[0-9a-zA-Z-]{1,64}$/;

/** Whether a subscribe names a work topic rather than a conversation. */
export function isWorkTopic(topic: string): boolean {
  return topic === MY_WORK_TOPIC || topic.startsWith(PROJECT_PREFIX);
}

/** The hub key a work topic subscribes to: `me` becomes the subscriber's own user topic. */
export function hubTopicFor(topic: string, userId: string): string {
  return topic === MY_WORK_TOPIC ? `${USER_PREFIX}${userId}` : topic;
}

/** The hub key work events for a project are published on. */
export function projectTopic(projectId: string): string {
  return `${PROJECT_PREFIX}${projectId}`;
}

/** The hub key a person's own work events are published on. */
export function userTopic(userId: string): string {
  return `${USER_PREFIX}${userId}`;
}

interface MembershipRow extends CustomRoleColumns {
  readonly role: string;
  readonly has_org_wide_scope: number;
  readonly on_project: number | null;
}

/** The pure rule over one membership row; exported for the unit suite. */
export function workTopicVerdict(row: MembershipRow | undefined, project: boolean): boolean {
  if (!row) return false;
  if (!roleHolds(internalPrincipalRole(row.role, row), 'work.read')) return false;
  if (!project) return true;
  return Boolean(row.has_org_wide_scope) || Boolean(row.on_project);
}

export async function checkWorkTopicSubscription(
  tx: WorkerTransaction,
  input: { readonly organizationId: string; readonly userId: string; readonly topic: string },
): Promise<SubscriptionVerdict> {
  const isMine = input.topic === MY_WORK_TOPIC || input.topic === userTopic(input.userId);
  const projectId = input.topic.startsWith(PROJECT_PREFIX)
    ? input.topic.slice(PROJECT_PREFIX.length)
    : null;
  if (!isMine && (projectId === null || !ID.test(projectId))) return REFUSED;

  const rows = await tx.query<readonly MembershipRow[]>(
    `SELECT m.role, ${CUSTOM_ROLE_COLUMNS}, m.has_org_wide_scope AS has_org_wide_scope,
            ${
              projectId === null
                ? 'NULL'
                : `(
              EXISTS (SELECT 1 FROM projects p WHERE p.organization_id = m.organization_id AND p.id = ?)
              AND (
                m.has_org_wide_scope = 1
                OR EXISTS (
                  SELECT 1 FROM project_memberships pm
                   WHERE pm.organization_id = m.organization_id
                     AND pm.project_id = ?
                     AND pm.user_id = m.user_id
                )
              )
            )`
            } AS on_project
       FROM memberships m
       ${customRoleJoin('m')}
      WHERE m.organization_id = ? AND m.user_id = ? AND m.status = 'active'`,
    projectId === null
      ? [input.organizationId, input.userId]
      : [projectId, projectId, input.organizationId, input.userId],
  );
  const row = rows[0];
  if (projectId !== null && row && !row.on_project) return REFUSED;
  return workTopicVerdict(row, projectId !== null) ? ALLOWED : REFUSED;
}

/**
 * The people a work item's event concerns for My Day: its owner and every doer and supervisor.
 * Tenant-scoped; bounded.
 */
export async function workItemPeople(
  tx: WorkerTransaction,
  organizationId: string,
  workItemId: string,
): Promise<readonly string[]> {
  const rows = await tx.query<readonly { readonly user_id: string | null }[]>(
    `SELECT w.owner_user_id AS user_id FROM work_items w
      WHERE w.organization_id = ? AND w.id = ?
     UNION
     SELECT m.user_id FROM work_item_assignees a
       JOIN memberships m ON m.organization_id = a.organization_id AND m.id = a.membership_id
      WHERE a.organization_id = ? AND a.work_item_id = ?
     LIMIT 200`,
    [organizationId, workItemId, organizationId, workItemId],
  );
  return rows.map((row) => row.user_id).filter((id): id is string => typeof id === 'string');
}
