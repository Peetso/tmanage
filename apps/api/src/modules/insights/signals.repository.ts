import { uuidv7 } from '@tmanage/domain';
import type { SignalRuleSetting, StoredSignalSetting } from '@tmanage/domain';
import type {
  QueryRows,
  TenantContext,
  TenantQueryRunner,
} from '../../common/database/tenant-context.js';

/**
 * 62-27 (0380) — the owner's signal settings, `work_signal_settings`. Bound SQL, the organization
 * from the verified context on every statement, the times bound by the service (never the
 * database clock). A save is one upsert per rule against `uq_work_signal_settings_rule`.
 */

export const SIGNAL_SETTINGS_SQL = {
  list: `SELECT rule_key, enabled, threshold, recipient FROM work_signal_settings
   WHERE organization_id = ?`,
  upsert: `INSERT INTO work_signal_settings
   (id, organization_id, rule_key, enabled, threshold, recipient, updated_by_user_id, created_at,
    updated_at)
 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
 ON DUPLICATE KEY UPDATE enabled = VALUES(enabled), threshold = VALUES(threshold),
   recipient = VALUES(recipient), updated_by_user_id = VALUES(updated_by_user_id),
   updated_at = VALUES(updated_at)`,
} as const;

export class SignalSettingsRepository {
  async list(
    runner: TenantQueryRunner,
    context: TenantContext,
  ): Promise<readonly StoredSignalSetting[]> {
    const rows = await runner.execute<QueryRows>(SIGNAL_SETTINGS_SQL.list, [
      context.organizationId,
    ]);
    return rows.map((row) => ({
      rule: String(row['rule_key']),
      enabled: row['enabled'] === 1 || row['enabled'] === true || row['enabled'] === '1',
      threshold: Number(row['threshold']),
      recipient: String(row['recipient']),
    }));
  }

  async save(
    runner: TenantQueryRunner,
    context: TenantContext,
    setting: SignalRuleSetting,
    at: Date,
  ): Promise<void> {
    await runner.execute(SIGNAL_SETTINGS_SQL.upsert, [
      uuidv7(),
      context.organizationId,
      setting.rule,
      setting.enabled ? 1 : 0,
      setting.threshold,
      setting.recipient,
      context.userId,
      at,
      at,
    ]);
  }
}
