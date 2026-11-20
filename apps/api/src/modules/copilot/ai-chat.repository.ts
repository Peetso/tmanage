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
 */

export const AI_CHAT_SQL = {
  standing: `select test_list_at, pool_class, write_scope, run_at_once from ai_workspace_settings
    where organization_id = ? limit 1`,
} as const;

export interface AiChatSettings {
  readonly onTestList: boolean;
  readonly poolClass: AiSpendingPool;
  readonly writeScope: AiWriteScope;
  readonly runAtOnce: boolean;
}

export class AiChatRepository {
  async settings(runner: TenantQueryRunner, context: TenantContext): Promise<AiChatSettings> {
    const rows = await runner.execute<QueryRows>(AI_CHAT_SQL.standing, [context.organizationId]);
    const row = rows[0];
    if (row === undefined)
      return {
        onTestList: false,
        poolClass: 'customers',
        writeScope: 'read',
        runAtOnce: false,
      };
    return {
      onTestList: row['test_list_at'] !== null && row['test_list_at'] !== undefined,
      poolClass: row['pool_class'] === 'testing' ? 'testing' : 'customers',
      writeScope: row['write_scope'] === 'read_write' ? 'read_write' : 'read',
      runAtOnce: row['run_at_once'] === 1 || row['run_at_once'] === true,
    };
  }
}
