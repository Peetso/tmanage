import type {
  QueryRows,
  TenantContext,
  TenantQueryRunner,
} from '../../common/database/tenant-context.js';

/**
 * R7 presence store (F4): one heartbeat row per person per studio in `user_presence`, and the
 * read that answers "online / last seen" for a list of people, with each person's own
 * "show last seen" choice (`user_preferences.prefs_json.showLastSeen`, default on).
 *
 * "Online" is computed by the database clock (`now(3)`), the same clock the heartbeat stamps
 * with, so an app server's skew never makes someone look offline.
 */

/** The window inside which a heartbeat counts as online. The web beats every 60 s. */
export const ONLINE_WINDOW_SECONDS = 120;

export interface PresenceRow {
  readonly userId: string;
  readonly lastSeenAt: Date;
  readonly online: boolean;
  /** The raw stored choice: `'false'` hides; anything else (or nothing) shows. */
  readonly showLastSeen: string | null;
}

export class PresenceRepository {
  /** Stamp the caller's heartbeat. One upsert on the `(organization_id, user_id)` key. */
  async heartbeat(
    runner: TenantQueryRunner,
    context: TenantContext,
    userId: string,
  ): Promise<void> {
    await runner.execute(
      `insert into user_presence (organization_id, user_id, last_seen_at)
       values (?, ?, current_timestamp(3))
       on duplicate key update last_seen_at = current_timestamp(3)`,
      [context.organizationId, userId],
    );
  }

  /** The stored presence of up to 100 people in this studio. Absent people are left out. */
  async list(
    runner: TenantQueryRunner,
    context: TenantContext,
    userIds: readonly string[],
  ): Promise<readonly PresenceRow[]> {
    if (userIds.length === 0) return [];
    const marks = userIds.map(() => '?').join(', ');
    const rows = await runner.execute<QueryRows>(
      `select p.user_id as user_id, p.last_seen_at as last_seen_at,
              (p.last_seen_at >= current_timestamp(3) - interval 120 second)
                as online,
              json_unquote(json_extract(up.prefs_json, '$.showLastSeen')) as show_last_seen
         from user_presence p
         left join memberships m
           on m.organization_id = p.organization_id and m.user_id = p.user_id
         left join user_preferences up
           on up.organization_id = m.organization_id and up.membership_id = m.id
        where p.organization_id = ? and p.user_id in (${marks})`,
      [context.organizationId, ...userIds],
    );
    return rows.map((row) => ({
      userId: String(row['user_id']),
      lastSeenAt: new Date(row['last_seen_at'] as string | Date),
      online: Number(row['online']) === 1,
      showLastSeen: row['show_last_seen'] == null ? null : String(row['show_last_seen']),
    }));
  }
}
