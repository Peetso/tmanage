import { hasCapability, isRole } from '@tmanage/domain';
import type { WorkerTransaction } from './worker-database.js';

/**
 * The reads a realtime subscription needs — RT-001, `13-ENGINEERING` §6's "subscription
 * request names authorized resource".
 *
 * The ticket proved a session; it proves nothing about a conversation. Every subscribe is
 * answered from **current** rows, the same discipline the notification consumers keep: an
 * active internal membership whose role ceiling includes `conversation.read`, and a
 * conversation-membership row for this person on this channel, both inside the ticket's
 * organization. A client principal cannot arrive here at all — no client role holds any
 * conversation capability, and the ceiling check answers that without a special case.
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
  interface Row {
    readonly role: string;
    readonly next_sequence_no: number;
    readonly is_member: number;
  }
  const rows = await tx.query<readonly Row[]>(
    `SELECT m.role, c.next_sequence_no,
            EXISTS (
              SELECT 1 FROM conversation_memberships cm
               WHERE cm.organization_id = c.organization_id
                 AND cm.conversation_id = c.id
                 AND cm.user_id = m.user_id
            ) AS is_member
       FROM conversations c
       JOIN memberships m
         ON m.organization_id = c.organization_id
        AND m.user_id = ?
        AND m.status = 'active'
      WHERE c.organization_id = ? AND c.id = ?`,
    [input.userId, input.organizationId, input.conversationId],
  );

  const row = rows[0];
  if (!row) return REFUSED;
  if (!isRole(row.role) || !hasCapability(row.role, 'conversation.read')) return REFUSED;
  if (!row.is_member) return REFUSED;
  return { allowed: true, cursor: Number(row.next_sequence_no) - 1 };
}
