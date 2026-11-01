import { mayDirectMessage } from '@tmanage/domain';
import type { DirectParty, PrincipalRole } from '@tmanage/domain';
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
 * BK3-left — the worker's reads for direct messages (0214/0216): the socket subscription check
 * and the recipient re-check behind the notice. Both apply `mayDirectMessage` from
 * `@tmanage/domain`, the same rule `DirectConversationsService` applies over HTTP on every call,
 * from **current** rows (§6: receipt of an event authorizes nothing). An internal participant
 * also needs `conversation.read` in their role, as the API requires of an internal caller.
 *
 * No message body is read here — `messages` is named nowhere; the frame and the notice carry
 * ids only. Since R7 (0276) a direct conversation is a `conversations` row (`kind = 'direct'`).
 */

/** A participant with the membership the per-kind opt-out is keyed by (internal only). */
export interface WorkerDirectParty extends DirectParty {
  /** The resolved principal role (H1: a custom role carries its own set); null for a client. */
  readonly role: PrincipalRole | null;
  readonly membershipId: string | null;
}

export async function findDirectParty(
  tx: WorkerTransaction,
  organizationId: string,
  userId: string,
): Promise<WorkerDirectParty | null> {
  const internal = await tx.query<readonly ({ id: string; role: string } & CustomRoleColumns)[]>(
    `SELECT m.id, m.role, ${CUSTOM_ROLE_COLUMNS}
       FROM memberships m
       ${customRoleJoin('m')}
      WHERE m.organization_id = ? AND m.user_id = ? AND m.status = 'active'
      LIMIT 1`,
    [organizationId, userId],
  );
  const membership = internal[0];
  if (membership !== undefined) {
    const projects = await tx.query<readonly { project_id: string }[]>(
      `SELECT project_id FROM project_memberships WHERE organization_id = ? AND user_id = ?`,
      [organizationId, userId],
    );
    return {
      userId,
      kind: 'internal',
      clientOrganizationIds: [],
      projectIds: projects.map((row) => row.project_id),
      role: internalPrincipalRole(membership.role, membership),
      membershipId: membership.id,
    };
  }

  const clients = await tx.query<readonly { client_organization_id: string }[]>(
    `SELECT client_organization_id FROM client_memberships
      WHERE organization_id = ? AND user_id = ? AND status = 'active'
        AND (expires_at IS NULL OR expires_at > current_timestamp(3))`,
    [organizationId, userId],
  );
  if (clients.length === 0) return null;
  const clientOrganizationIds = clients.map((row) => row.client_organization_id);
  const placeholders = clientOrganizationIds.map(() => '?').join(', ');
  const projects = await tx.query<readonly { project_id: string }[]>(
    `SELECT project_id FROM project_clients
      WHERE organization_id = ? AND client_organization_id IN (${placeholders})`,
    [organizationId, ...clientOrganizationIds],
  );
  return {
    userId,
    kind: 'client',
    clientOrganizationIds,
    projectIds: projects.map((row) => row.project_id),
    role: null,
    membershipId: null,
  };
}

/** May `self` read this direct conversation with `other` right now? Pure; see the file note. */
export function mayReadDirect(
  self: WorkerDirectParty | null,
  other: WorkerDirectParty | null,
): boolean {
  if (self === null || !mayDirectMessage(self, other)) return false;
  if (self.kind === 'client') return true;
  return roleHolds(self.role, 'conversation.read');
}

/**
 * The socket subscription check for a member-gated conversation (R7: a direct conversation or a
 * group, both rows of `conversations` since 0276). The subscriber needs a
 * `conversation_memberships` row, and then:
 * - direct: the pair's relation still holds (`mayReadDirect`, as before the storage switch);
 * - group: an internal member whose role holds `conversation.read`, or a client with a live
 *   client membership (`authorize` rule 2a admits a client to a group they are in).
 * The cursor is the conversation's last handed-out number.
 */
export async function checkDirectConversationSubscription(
  tx: WorkerTransaction,
  input: {
    readonly organizationId: string;
    readonly userId: string;
    readonly conversationId: string;
  },
): Promise<SubscriptionVerdict> {
  const rows = await tx.query<
    readonly {
      kind: string;
      direct_user_low_id: string | null;
      direct_user_high_id: string | null;
      next_sequence_no: number;
    }[]
  >(
    `SELECT c.kind, c.direct_user_low_id, c.direct_user_high_id, c.next_sequence_no
       FROM conversations c
       JOIN conversation_memberships cm
         ON cm.organization_id = c.organization_id
        AND cm.conversation_id = c.id
        AND cm.user_id = ?
      WHERE c.organization_id = ? AND c.id = ? AND c.kind IN ('direct', 'group')`,
    [input.userId, input.organizationId, input.conversationId],
  );
  const row = rows[0];
  if (row === undefined) return { allowed: false, cursor: 0 };
  const self = await findDirectParty(tx, input.organizationId, input.userId);
  if (row.kind === 'group') {
    if (self === null) return { allowed: false, cursor: 0 };
    if (self.kind === 'internal' && !roleHolds(self.role, 'conversation.read')) {
      return { allowed: false, cursor: 0 };
    }
    return { allowed: true, cursor: Number(row.next_sequence_no) - 1 };
  }
  const otherUserId =
    row.direct_user_low_id === input.userId ? row.direct_user_high_id : row.direct_user_low_id;
  if (otherUserId === null) return { allowed: false, cursor: 0 };
  const other = await findDirectParty(tx, input.organizationId, otherUserId);
  if (!mayReadDirect(self, other)) return { allowed: false, cursor: 0 };
  return { allowed: true, cursor: Number(row.next_sequence_no) - 1 };
}
