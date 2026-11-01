import type { WorkerTransaction } from './worker-database.js';

/**
 * R7 slice 6: the two people of a direct conversation (a `conversations` row with
 * `kind = 'direct'` since 0276), for the direct-message notice on `message.created.v1`.
 * Null for any other kind or an unknown id. Ids only — no message body is read.
 */
export async function findDirectPair(
  tx: WorkerTransaction,
  organizationId: string,
  conversationId: string,
): Promise<{ readonly lowUserId: string; readonly highUserId: string } | null> {
  const rows = await tx.query<
    readonly { direct_user_low_id: string | null; direct_user_high_id: string | null }[]
  >(
    `SELECT direct_user_low_id, direct_user_high_id FROM conversations
      WHERE organization_id = ? AND id = ? AND kind = 'direct'`,
    [organizationId, conversationId],
  );
  const row = rows[0];
  if (!row || row.direct_user_low_id === null || row.direct_user_high_id === null) return null;
  return { lowUserId: row.direct_user_low_id, highUserId: row.direct_user_high_id };
}
