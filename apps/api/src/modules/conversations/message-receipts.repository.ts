import type {
  QueryRows,
  TenantContext,
  TenantQueryRunner,
} from '../../common/database/tenant-context.js';

/**
 * R7 receipts (F4): who a message was delivered to and who has read it, derived from
 * `conversation_read_state` — a member's last-read (or last-delivered) message sequence at or
 * after this message's sequence. Nothing new is stored per message.
 */

/** One member's positions in the conversation, as the query reads them. */
export interface ReceiptPositionRow {
  readonly userId: string;
  readonly displayName: string;
  readonly readSequence: number | null;
  readonly deliveredSequence: number | null;
  readonly readAt: Date;
  readonly updatedAt: Date;
}

export interface ReceiptEntry {
  readonly userId: string;
  readonly displayName: string;
  readonly at: string;
}

export interface MessageReceiptsView {
  readonly deliveredTo: readonly ReceiptEntry[];
  readonly readBy: readonly ReceiptEntry[];
}

/**
 * Pure: the receipts of the message at `sequence`. Reading implies delivery, so everyone in
 * `readBy` is also in `deliveredTo`. The author is never their own recipient.
 */
export function deriveReceipts(
  rows: readonly ReceiptPositionRow[],
  sequence: number,
  authorUserId: string,
): MessageReceiptsView {
  const deliveredTo: ReceiptEntry[] = [];
  const readBy: ReceiptEntry[] = [];
  for (const row of rows) {
    if (row.userId === authorUserId) continue;
    const read = row.readSequence !== null && row.readSequence >= sequence;
    const delivered = read || (row.deliveredSequence !== null && row.deliveredSequence >= sequence);
    if (read) {
      readBy.push({
        userId: row.userId,
        displayName: row.displayName,
        at: row.readAt.toISOString(),
      });
    }
    if (delivered) {
      deliveredTo.push({
        userId: row.userId,
        displayName: row.displayName,
        at: (read ? row.readAt : row.updatedAt).toISOString(),
      });
    }
  }
  return { deliveredTo, readBy };
}

export class MessageReceiptsRepository {
  /** Every stored position in one conversation, tenant-scoped, with each member's name. */
  async listPositions(
    runner: TenantQueryRunner,
    context: TenantContext,
    conversationId: string,
  ): Promise<readonly ReceiptPositionRow[]> {
    const rows = await runner.execute<QueryRows>(
      `select m.user_id as user_id, u.display_name as display_name,
              lr.sequence_no as read_sequence, ld.sequence_no as delivered_sequence,
              rs.read_at as read_at, rs.updated_at as updated_at
         from conversation_read_state rs
         join memberships m
           on m.organization_id = rs.organization_id and m.id = rs.membership_id
         join users u on u.id = m.user_id
         left join messages lr
           on lr.organization_id = rs.organization_id and lr.id = rs.last_read_message_id
         left join messages ld
           on ld.organization_id = rs.organization_id and ld.id = rs.last_delivered_message_id
        where rs.organization_id = ? and rs.conversation_id = ?`,
      [context.organizationId, conversationId],
    );
    return rows.map((row) => ({
      userId: String(row['user_id']),
      displayName: String(row['display_name']),
      readSequence: row['read_sequence'] == null ? null : Number(row['read_sequence']),
      deliveredSequence:
        row['delivered_sequence'] == null ? null : Number(row['delivered_sequence']),
      readAt: new Date(row['read_at'] as string | Date),
      updatedAt: new Date(row['updated_at'] as string | Date),
    }));
  }
}
