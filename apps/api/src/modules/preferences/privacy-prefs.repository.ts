import { uuidv7 } from '@tmanage/domain';
import type {
  QueryRows,
  TenantContext,
  TenantQueryRunner,
} from '../../common/database/tenant-context.js';
import { DEFAULT_USER_PREFERENCES } from './preferences.controller.js';

/**
 * R7 privacy preference "show last seen / online" (F4), stored as `showLastSeen` beside the
 * appearance keys in the caller's own `user_preferences.prefs_json` — no new column. The write is
 * one upsert that merges just this key (`json_merge_patch`), so the appearance settings stay as
 * they were; PREF-001's own save merges the same way, so it keeps this key in turn.
 */
export class PrivacyPreferencesRepository {
  /** The stored choice; `true` (visible) when never saved. */
  async readShowLastSeen(
    runner: TenantQueryRunner,
    context: TenantContext,
    membershipId: string,
  ): Promise<boolean> {
    const rows = await runner.execute<QueryRows>(
      `select json_unquote(json_extract(prefs_json, '$.showLastSeen')) as show_last_seen
         from user_preferences
        where organization_id = ? and membership_id = ?
        limit 1`,
      [context.organizationId, membershipId],
    );
    return String(rows[0]?.['show_last_seen'] ?? 'true') !== 'false';
  }

  async writeShowLastSeen(
    runner: TenantQueryRunner,
    context: TenantContext,
    membershipId: string,
    showLastSeen: boolean,
  ): Promise<void> {
    const patch = JSON.stringify({ showLastSeen });
    await runner.execute(
      `insert into user_preferences
         (id, organization_id, membership_id, prefs_json, created_at, updated_at)
       values (?, ?, ?, ?, current_timestamp(3), current_timestamp(3))
       on duplicate key update prefs_json = json_merge_patch(prefs_json, ?),
                               updated_at = current_timestamp(3)`,
      [
        uuidv7(),
        context.organizationId,
        membershipId,
        JSON.stringify({ ...DEFAULT_USER_PREFERENCES, showLastSeen }),
        patch,
      ],
    );
  }
}
