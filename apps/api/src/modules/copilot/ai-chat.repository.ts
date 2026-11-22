import type {
  QueryRows,
  TenantContext,
  TenantQueryRunner,
} from '../../common/database/tenant-context.js';
import type { AiSpendingPool } from './ai-tiers.js';
import type { AiWriteScope } from './copilot-chat.service.js';

/**
 * 62-09 — the one read the chat gates need from `ai_workspace_settings` (copilot-owned, 0383):
 * the test-list mark, the pool class and the owner's write and "run at once" settings, tenant-bound
 * (DA-12). No row = the defaults: not listed, customers pool, read only, run at once off.
 *
 * 62-17 adds the owner's master switch (`ai_enabled`, default off), "let AI read files"
 * (`file_reading`, 0403, default on) and whether the calling member is on the owner's block list
 * (`ai_member_blocks`, 0403).
 */

export const AI_CHAT_SQL = {
  standing: `select test_list_at, pool_class, write_scope, run_at_once, ai_enabled, file_reading
    from ai_workspace_settings where organization_id = ? limit 1`,
  blocked: `select 1 as blocked from ai_member_blocks
    where organization_id = ? and membership_id = ? limit 1`,
} as const;

export interface AiChatSettings {
  readonly onTestList: boolean;
  readonly poolClass: AiSpendingPool;
  readonly writeScope: AiWriteScope;
  readonly runAtOnce: boolean;
  /** The owner's master switch (`ai_enabled`); off = TManage AI is absent for every member. */
  readonly aiEnabled: boolean;
  /** "Let AI read files" (`file_reading`); off = a file question is refused before any call. */
  readonly fileReading: boolean;
  /** The calling member is on the owner's block list. */
  readonly memberBlocked: boolean;
}

/** A MySQL/MariaDB boolean as the driver returns it (1/0, true/false or '1'/'0'). */
export const sqlFlag = (value: unknown): boolean => value === 1 || value === true || value === '1';

export class AiChatRepository {
  async settings(runner: TenantQueryRunner, context: TenantContext): Promise<AiChatSettings> {
    const rows = await runner.execute<QueryRows>(AI_CHAT_SQL.standing, [context.organizationId]);
    const blocked = await runner.execute<QueryRows>(AI_CHAT_SQL.blocked, [
      context.organizationId,
      context.membershipId,
    ]);
    const memberBlocked = blocked.length > 0;
    const row = rows[0];
    if (row === undefined)
      return {
        onTestList: false,
        poolClass: 'customers',
        writeScope: 'read',
        runAtOnce: false,
        aiEnabled: false,
        fileReading: true,
        memberBlocked,
      };
    return {
      onTestList: row['test_list_at'] !== null && row['test_list_at'] !== undefined,
      poolClass: row['pool_class'] === 'testing' ? 'testing' : 'customers',
      writeScope: row['write_scope'] === 'read_write' ? 'read_write' : 'read',
      runAtOnce: sqlFlag(row['run_at_once']),
      aiEnabled: sqlFlag(row['ai_enabled']),
      fileReading: sqlFlag(row['file_reading']),
      memberBlocked,
    };
  }
}
