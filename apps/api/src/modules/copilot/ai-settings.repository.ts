import type { ResultSetHeader } from 'mysql2';
import type {
  QueryRows,
  TenantContext,
  TenantQueryRunner,
} from '../../common/database/tenant-context.js';
import { sqlFlag } from './ai-chat.repository.js';
import type { AiWriteScope } from './copilot-chat.service.js';

/**
 * 62-17 — every statement of Settings > AI (owner): the owner's columns of `ai_workspace_settings`
 * (0383, 0392, 0403) and the block list `ai_member_blocks` (0403). Every statement names the
 * organization (DA-12); every time is a bound value (DA-10). The platform-owned columns
 * (`test_list_at`, `pool_class`) are read, never written here.
 */

export const AI_SETTINGS_SQL = {
  read: `select test_list_at, ai_enabled, write_scope, run_at_once, file_reading,
      member_share_percent, conversation_retention_days, updated_at
    from ai_workspace_settings where organization_id = ? limit 1`,
  readForUpdate: `select test_list_at, ai_enabled, write_scope, run_at_once, file_reading,
      member_share_percent, conversation_retention_days, updated_at
    from ai_workspace_settings where organization_id = ? limit 1 for update`,
  update: `update ai_workspace_settings
    set ai_enabled = ?, write_scope = ?, run_at_once = ?, file_reading = ?,
      member_share_percent = ?, conversation_retention_days = ?,
      updated_by_membership_id = ?, updated_at = ?
    where organization_id = ?`,
  blockedMembers: `select b.membership_id, b.created_at, u.display_name
    from ai_member_blocks b
    join memberships m on m.organization_id = b.organization_id and m.id = b.membership_id
    join users u on u.id = m.user_id
    where b.organization_id = ?
    order by u.display_name, b.membership_id`,
  isBlocked: `select 1 as blocked from ai_member_blocks
    where organization_id = ? and membership_id = ? limit 1`,
  member: `select id, role, kind from memberships where organization_id = ? and id = ? limit 1`,
  block: `insert into ai_member_blocks
    (organization_id, membership_id, blocked_by_membership_id, created_at) values (?, ?, ?, ?)`,
  allow: `delete from ai_member_blocks where organization_id = ? and membership_id = ?`,
} as const;

/** The owner's settings as stored; `onTestList` is the platform's mark. */
export interface AiOwnerSettingsRow {
  readonly onTestList: boolean;
  readonly aiEnabled: boolean;
  readonly writeScope: AiWriteScope;
  readonly runAtOnce: boolean;
  readonly fileReading: boolean;
  readonly memberSharePercent: number;
  readonly conversationRetentionDays: number;
  readonly updatedAt: Date | null;
}

export type AiOwnerSettings = Omit<AiOwnerSettingsRow, 'onTestList' | 'updatedAt'>;

export interface AiBlockedMemberRow {
  readonly membershipId: string;
  readonly displayName: string;
  readonly blockedAt: Date;
}

export interface AiSettingsMemberRow {
  readonly id: string;
  readonly role: string;
  readonly kind: string;
}

const asDate = (value: unknown): Date => (value instanceof Date ? value : new Date(String(value)));

const whole = (value: unknown, fallback: number): number => {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? Math.floor(n) : fallback;
};

function settingsOf(row: Readonly<Record<string, unknown>>): AiOwnerSettingsRow {
  return {
    onTestList: row['test_list_at'] !== null && row['test_list_at'] !== undefined,
    aiEnabled: sqlFlag(row['ai_enabled']),
    writeScope: row['write_scope'] === 'read_write' ? 'read_write' : 'read',
    runAtOnce: sqlFlag(row['run_at_once']),
    fileReading: sqlFlag(row['file_reading']),
    memberSharePercent: whole(row['member_share_percent'], 50),
    conversationRetentionDays: whole(row['conversation_retention_days'], 30),
    updatedAt:
      row['updated_at'] === null || row['updated_at'] === undefined
        ? null
        : asDate(row['updated_at']),
  };
}

export class AiSettingsRepository {
  /** The workspace's row, or `null` when it has none (never on the test list). */
  async read(
    runner: TenantQueryRunner,
    context: TenantContext,
    lock = false,
  ): Promise<AiOwnerSettingsRow | null> {
    const rows = await runner.execute<QueryRows>(
      lock ? AI_SETTINGS_SQL.readForUpdate : AI_SETTINGS_SQL.read,
      [context.organizationId],
    );
    return rows[0] === undefined ? null : settingsOf(rows[0]);
  }

  async write(
    runner: TenantQueryRunner,
    context: TenantContext,
    settings: AiOwnerSettings,
    at: Date,
  ): Promise<void> {
    await runner.execute<ResultSetHeader>(AI_SETTINGS_SQL.update, [
      settings.aiEnabled ? 1 : 0,
      settings.writeScope,
      settings.runAtOnce ? 1 : 0,
      settings.fileReading ? 1 : 0,
      settings.memberSharePercent,
      settings.conversationRetentionDays,
      context.membershipId,
      at,
      context.organizationId,
    ]);
  }

  async blockedMembers(
    runner: TenantQueryRunner,
    context: TenantContext,
  ): Promise<readonly AiBlockedMemberRow[]> {
    const rows = await runner.execute<QueryRows>(AI_SETTINGS_SQL.blockedMembers, [
      context.organizationId,
    ]);
    return rows.map((row) => ({
      membershipId: String(row['membership_id']),
      displayName: String(row['display_name'] ?? ''),
      blockedAt: asDate(row['created_at']),
    }));
  }

  /** A membership of this workspace, or `null` (another workspace's id reads as absent). */
  async member(
    runner: TenantQueryRunner,
    context: TenantContext,
    membershipId: string,
  ): Promise<AiSettingsMemberRow | null> {
    const rows = await runner.execute<QueryRows>(AI_SETTINGS_SQL.member, [
      context.organizationId,
      membershipId,
    ]);
    const row = rows[0];
    if (row === undefined) return null;
    return { id: String(row['id']), role: String(row['role']), kind: String(row['kind']) };
  }

  /** Blocks the member; `false` when they were already blocked (one row, HT-4). */
  async block(
    runner: TenantQueryRunner,
    context: TenantContext,
    membershipId: string,
    at: Date,
  ): Promise<boolean> {
    const rows = await runner.execute<QueryRows>(AI_SETTINGS_SQL.isBlocked, [
      context.organizationId,
      membershipId,
    ]);
    if (rows.length > 0) return false;
    await runner.execute<ResultSetHeader>(AI_SETTINGS_SQL.block, [
      context.organizationId,
      membershipId,
      context.membershipId,
      at,
    ]);
    return true;
  }

  /** Lifts the block; `false` when the member was not blocked. */
  async allow(
    runner: TenantQueryRunner,
    context: TenantContext,
    membershipId: string,
  ): Promise<boolean> {
    const result = await runner.execute<ResultSetHeader>(AI_SETTINGS_SQL.allow, [
      context.organizationId,
      membershipId,
    ]);
    return result.affectedRows === 1;
  }
}
