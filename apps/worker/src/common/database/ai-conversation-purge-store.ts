import { uuidv7 } from '@tmanage/domain';
import type { WorkerDatabase } from './worker-database.js';
import {
  AI_CONVERSATION_DEFAULT_RETENTION_DAYS,
  AI_CONVERSATION_MIN_RETENTION_DAYS,
  AI_CONVERSATION_PURGE_ACTION,
  type AiConversationPurgeStore,
} from '../../jobs/ai-conversation-purge.js';
import { SYSTEM_ACTOR_EMAIL, SYSTEM_ACTOR_ID } from '../../jobs/security-report-purge.js';

/**
 * 62-13: the AI conversation purge's statements, over the worker's pool. `tmanage_worker` holds
 * SELECT on `ai_workspace_settings`, SELECT and DELETE on `ai_conversations` and
 * `ai_conversation_messages`, and INSERT on `platform_admin_audit_events` (scripts/db/users.sql,
 * DA-9). The bound is always a bound JS Date; each workspace's window is subtracted from it here.
 *
 * The purge is cross-tenant by design (one sweep over every workspace), the documented DA-12 bend
 * of this pool; every join still pairs rows on `organization_id`, so a conversation is measured
 * against its own workspace's setting only and only its own messages are removed.
 */

const DEFAULT_DAYS = String(AI_CONVERSATION_DEFAULT_RETENTION_DAYS);

/** The workspace's window, or the default when it has no settings row. */
const PAST_WINDOW = `c.last_message_at < date_sub(?, interval coalesce(s.conversation_retention_days, ${DEFAULT_DAYS}) day)`;

const SETTINGS_JOIN = `left join ai_workspace_settings s on s.organization_id = c.organization_id`;

// The first bound (now minus the shortest window) lets `ix_ai_conversations_last` cut the scan.
const LIST_EXPIRED = `select c.id as id from ai_conversations c ${SETTINGS_JOIN}
 where c.last_message_at < ? and ${PAST_WINDOW} and c.id > ?
 order by c.id limit ?`;

const inList = (count: number) => Array.from({ length: count }, () => '?').join(', ');

const DELETE_MESSAGES = (count: number) => `delete m from ai_conversation_messages m
 join ai_conversations c on c.organization_id = m.organization_id and c.id = m.conversation_id
 ${SETTINGS_JOIN}
 where c.id in (${inList(count)}) and ${PAST_WINDOW}`;

const DELETE_CONVERSATIONS = (count: number) => `delete c from ai_conversations c ${SETTINGS_JOIN}
 where c.id in (${inList(count)}) and ${PAST_WINDOW}`;

const PLATFORM_AUDIT = `INSERT INTO platform_admin_audit_events
   (id, actor_user_id, actor_email, action, target_type, target_id, target_label,
    organization_id, reason, correlation_id, created_at, support_session_id, before_json,
    after_json, ip, user_agent)
 VALUES (?, ?, ?, ?, 'ai_conversation', NULL, NULL, NULL, ?, ?, current_timestamp(3), NULL, NULL,
         ?, NULL, NULL)`;

const DAY_MS = 24 * 60 * 60 * 1000;

export function createAiConversationPurgeStore(database: WorkerDatabase): AiConversationPurgeStore {
  return {
    listExpired: (now, afterId, limit) =>
      database.read(async (tx) => {
        const floor = new Date(now.getTime() - AI_CONVERSATION_MIN_RETENTION_DAYS * DAY_MS);
        const rows = await tx.query<readonly { id: string }[]>(LIST_EXPIRED, [
          floor,
          now,
          afterId ?? '',
          Math.max(1, Math.trunc(limit)),
        ]);
        return rows.map((row) => row.id);
      }),
    deleteExpired: (ids, now) =>
      ids.length === 0
        ? Promise.resolve(0)
        : database.transaction(async (tx) => {
            await tx.query(DELETE_MESSAGES(ids.length), [...ids, now]);
            const result = await tx.query<{ affectedRows: number }>(
              DELETE_CONVERSATIONS(ids.length),
              [...ids, now],
            );
            return result.affectedRows;
          }),
    audit: (deleted, now) =>
      database.transaction(async (tx) => {
        await tx.query(PLATFORM_AUDIT, [
          uuidv7(),
          SYSTEM_ACTOR_ID,
          SYSTEM_ACTOR_EMAIL,
          AI_CONVERSATION_PURGE_ACTION,
          `retention per workspace, default ${DEFAULT_DAYS} days`,
          uuidv7(),
          JSON.stringify({ deleted, at: now.toISOString() }),
        ]);
      }),
  };
}
