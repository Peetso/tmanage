import type { WorkerTransaction } from './worker-database.js';
import {
  CUSTOM_ROLE_COLUMNS,
  customRoleJoin,
  internalPrincipalRole,
  roleHolds,
} from './principal-role.js';
import type { CustomRoleColumns } from './principal-role.js';

/**
 * The reads a realtime subscription needs — RT-001, `13-ENGINEERING` §6's "subscription
 * request names authorized resource".
 *
 * The ticket proved a session; it proves nothing about a conversation. Every subscribe is
 * answered from **current** rows, the same discipline the notification consumers keep: an
 * active internal membership whose role ceiling includes `conversation.read`, a current
 * relation to the channel's **project** (org-wide scope, or an explicit `project_memberships`
 * row — the same project gate `authorize()`'s rule 12 applies over HTTP), and a
 * conversation-membership row for this person on this channel, all inside the ticket's
 * organization. A client principal cannot arrive here at all — no client role holds any
 * conversation capability, and the ceiling check answers that without a special case.
 *
 * The project gate closes REVIEW R04's "align the initial check with the HTTP project's
 * access rules as well": `checkConversationSubscription` used to pass on membership + ceiling
 * + channel row alone, so a user removed from the project (their `project_memberships` row
 * revoked) but still carrying a stale `conversation_memberships` row kept receiving that
 * project's events over the socket, while the HTTP path (`ConversationsService.mayReach`)
 * would 404 them. A refusal here is the module's ordinary `REFUSED` verdict; the socket layer
 * answers it with an opaque `{type:'refused'}` frame, so the denial says nothing about which
 * of the three conditions failed — the same anti-oracle stance the handshake takes.
 */

export interface SubscriptionVerdict {
  readonly allowed: boolean;
  /**
   * The channel's cursor at subscription time: the last sequence number the allocator has
   * handed out. §6's "server returns current cursor" — a client compares broadcast
   * sequences against it and refetches on a gap.
   */
  readonly cursor: number;
}

const REFUSED: SubscriptionVerdict = { allowed: false, cursor: 0 };

export async function checkConversationSubscription(
  tx: WorkerTransaction,
  input: {
    readonly organizationId: string;
    readonly userId: string;
    readonly conversationId: string;
  },
): Promise<SubscriptionVerdict> {
  interface Row extends CustomRoleColumns {
    readonly role: string;
    readonly next_sequence_no: number;
    readonly is_member: number;
    readonly may_reach_project: number;
    readonly has_org_wide_scope: number;
  }
  const rows = await tx.query<readonly Row[]>(
    `SELECT m.role, ${CUSTOM_ROLE_COLUMNS}, c.next_sequence_no,
            m.has_org_wide_scope AS has_org_wide_scope,
            EXISTS (
              SELECT 1 FROM conversation_memberships cm
               WHERE cm.organization_id = c.organization_id
                 AND cm.conversation_id = c.id
                 AND cm.user_id = m.user_id
            ) AS is_member,
            (
              m.has_org_wide_scope = 1
              OR EXISTS (
                   SELECT 1 FROM project_memberships pm
                    WHERE pm.organization_id = c.organization_id
                      AND pm.project_id = c.project_id
                      AND pm.user_id = m.user_id
                 )
            ) AS may_reach_project
       FROM conversations c
       JOIN memberships m
         ON m.organization_id = c.organization_id
        AND m.user_id = ?
        AND m.status = 'active'
       ${customRoleJoin('m')}
      WHERE c.organization_id = ? AND c.id = ?`,
    [input.userId, input.organizationId, input.conversationId],
  );

  const row = rows[0];
  if (!row) return REFUSED;
  // H1: a custom-role member is checked against their role's own set, not skipped.
  if (!roleHolds(internalPrincipalRole(row.role, row), 'conversation.read')) return REFUSED;
  // The project gate `authorize()` applies over HTTP (rule 12): a channel membership row is
  // not on its own a licence to the project the channel belongs to. Without this, a revoked
  // project member with a stale conversation-membership row keeps receiving the project's
  // events, though the HTTP API would refuse them.
  if (!row.may_reach_project) return REFUSED;
  // The channel-membership half of the same alignment (review-x33 finding I1). Over HTTP
  // `ConversationsService.mayReach` returns true for an org-wide principal that clears the
  // project gate *without* a `conversation_memberships` row ("an Owner could not read a
  // channel until somebody added them to it"). Mirror that here so the two read paths agree:
  // an org-wide principal needs no channel row, everyone else still does. Non-org-wide,
  // revoked, and removed principals stay refused — the project gate above already saw to that.
  if (!row.has_org_wide_scope && !row.is_member) return REFUSED;
  return { allowed: true, cursor: Number(row.next_sequence_no) - 1 };
}
