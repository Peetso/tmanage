/**
 * 62-13 (plan 62 §9 row, §7 retention): the retention purge of the in-app AI's conversations
 * (`ai_conversations`, `ai_conversation_messages`, migration 0392). Once a day in loop mode, every
 * conversation whose last message is older than its workspace's `conversation_retention_days`
 * (`ai_workspace_settings`, default {@link AI_CONVERSATION_DEFAULT_RETENTION_DAYS}; the owner sets 1
 * to 365) is deleted with its messages, in {@link AI_CONVERSATION_PURGE_BATCH}-row batches ordered
 * by id, at most {@link AI_CONVERSATION_PURGE_MAX_BATCHES} batches a run; the next run takes the
 * rest (IP-17, AS-6: one bounded pass).
 *
 * - The bound is a bound JS `Date` (`now`), never the database's `NOW()` (an admin pool's clock is
 *   SYSTEM, not UTC); each workspace's window is subtracted from it in the statement (DA-3).
 * - Each DELETE repeats the bound, so a conversation that got a new message after it was listed is
 *   kept. Messages go first, then their conversation (no foreign key, 0257 convention).
 * - One platform audit row per run, `platform.ai_conversations_purged`, with the count and the
 *   bound only — never a title, a message or a member. Actor `SYSTEM_ACTOR_ID` (`security-report-purge.ts`).
 *
 * This file holds no SQL; `common/database/ai-conversation-purge-store.ts` does (worker grants:
 * SELECT on `ai_workspace_settings`, SELECT and DELETE on both conversation tables, INSERT on
 * `platform_admin_audit_events`).
 */

export const AI_CONVERSATION_DEFAULT_RETENTION_DAYS = 30;
/** The shortest window an owner can set: nothing younger than this is ever a candidate. */
export const AI_CONVERSATION_MIN_RETENTION_DAYS = 1;
export const AI_CONVERSATION_PURGE_BATCH = 200;
export const AI_CONVERSATION_PURGE_MAX_BATCHES = 50;
export const AI_CONVERSATION_PURGE_INTERVAL_MS = 24 * 60 * 60 * 1000;
export const AI_CONVERSATION_PURGE_ACTION = 'platform.ai_conversations_purged';

/** The statements the purge needs. Faked by the unit test. */
export interface AiConversationPurgeStore {
  /** Ids of conversations past their workspace's window at `now`, ordered by id, after `afterId`. */
  listExpired(now: Date, afterId: string | null, limit: number): Promise<readonly string[]>;
  /** Delete those still past the window, messages first; returns the conversations removed. */
  deleteExpired(ids: readonly string[], now: Date): Promise<number>;
  /** The run's count-only platform audit row. */
  audit(deleted: number, now: Date): Promise<void>;
}

export interface AiConversationPurgeResult {
  readonly deleted: number;
  readonly at: string;
  /** True when the batch cap stopped the run with rows possibly left. */
  readonly capped: boolean;
}

export async function purgeAiConversations(deps: {
  readonly store: AiConversationPurgeStore;
  readonly now?: () => Date;
  readonly batch?: number;
  readonly maxBatches?: number;
}): Promise<AiConversationPurgeResult> {
  const now = (deps.now ?? (() => new Date()))();
  const batch = Math.max(1, Math.trunc(deps.batch ?? AI_CONVERSATION_PURGE_BATCH));
  const maxBatches = deps.maxBatches ?? AI_CONVERSATION_PURGE_MAX_BATCHES;
  let deleted = 0;
  let cursor: string | null = null;
  let capped = false;
  for (let round = 0; ; round += 1) {
    if (round >= maxBatches) {
      capped = true;
      break;
    }
    const ids = await deps.store.listExpired(now, cursor, batch);
    if (ids.length === 0) break;
    deleted += await deps.store.deleteExpired(ids, now);
    if (ids.length < batch) break;
    cursor = ids[ids.length - 1] as string;
  }
  await deps.store.audit(deleted, now);
  return { deleted, at: now.toISOString(), capped };
}
