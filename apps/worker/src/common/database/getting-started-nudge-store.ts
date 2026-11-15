import type { WorkerDatabase } from './worker-database.js';
import { insertNotification } from './notifications-store.js';
import {
  GETTING_STARTED_NUDGE_TYPE,
  GETTING_STARTED_OBJECT_TYPE,
  NUDGE_STEPS,
  NUDGE_WINDOW_DAYS,
} from '../../jobs/getting-started-nudges.js';
import type { NudgeCandidate, NudgeStep, NudgeStore } from '../../jobs/getting-started-nudges.js';

/**
 * 55-24 — the first-week nudge sweep's statements, over the worker's own pool.
 *
 * One read lists every active member who joined within the window, with their in-app toggle and
 * quiet hours (`notification_preferences`), their stored `gettingStarted` key
 * (`user_preferences.prefs_json`) and the company signals the API's checklist uses. The write is
 * one `notifications` row whose dedupe key carries the member and the day, so the unique key makes
 * "at most one a day" hold across overlapping sweeps; `nudges_today` (an indexed count over
 * `ix_notifications_recipient_time`) feeds the job's hard daily cap on top. Grants: SELECT on the read tables
 * (`client_organizations` and `oauth_grants` added for this sweep in scripts/db/users.sql) and the
 * INSERT on `notifications` the worker already holds.
 */

const BATCH = 1000;

export interface NudgeRow {
  readonly membership_id: string;
  readonly organization_id: string;
  readonly user_id: string;
  readonly created_at: Date | string;
  readonly in_app_enabled: number | null;
  readonly quiet_hours_start: string | null;
  readonly quiet_hours_end: string | null;
  readonly quiet_hours_timezone: string | null;
  readonly gs_json: unknown;
  readonly invite_teammate: number;
  readonly create_project: number;
  readonly add_client: number;
  readonly connect_storage: number;
  readonly set_working_hours: number;
  readonly try_ai_assistant: number;
  readonly nudges_today: number | string;
}

/** The stored `gettingStarted` value: hand-marked steps and whether it was dismissed. */
export function readStored(raw: unknown): { marked: NudgeStep[]; dismissed: boolean } {
  let value: unknown = raw;
  if (typeof raw === 'string') {
    try {
      value = JSON.parse(raw);
    } catch {
      value = null;
    }
  }
  if (value === null || typeof value !== 'object') return { marked: [], dismissed: false };
  const record = value as Record<string, unknown>;
  const marked = Array.isArray(record['marked'])
    ? NUDGE_STEPS.filter((s) => (record['marked'] as unknown[]).includes(s))
    : [];
  return { marked, dismissed: typeof record['dismissedAt'] === 'string' };
}

export function candidateOf(row: NudgeRow): NudgeCandidate {
  const stored = readStored(row.gs_json);
  const done = new Set<NudgeStep>(stored.marked);
  for (const step of NUDGE_STEPS) if (Number(row[step]) === 1) done.add(step);
  return {
    organizationId: row.organization_id,
    membershipId: row.membership_id,
    userId: row.user_id,
    joinedAt: row.created_at instanceof Date ? row.created_at : new Date(row.created_at),
    inAppEnabled: row.in_app_enabled === null ? true : Boolean(Number(row.in_app_enabled)),
    quietHours: {
      quietHoursStart: row.quiet_hours_start,
      quietHoursEnd: row.quiet_hours_end,
      quietHoursTimezone: row.quiet_hours_timezone,
    },
    dismissed: stored.dismissed,
    done,
    nudgesToday: Number(row.nudges_today),
  };
}

export function createGettingStartedNudgeStore(database: WorkerDatabase): NudgeStore {
  return {
    listCandidates: (now) =>
      database.transaction(async (tx) => {
        const utcMidnight = new Date(`${now.toISOString().slice(0, 10)}T00:00:00.000Z`);
        const rows = await tx.query<readonly NudgeRow[]>(
          `SELECT m.id AS membership_id, m.organization_id, m.user_id, m.created_at,
                  np.in_app_enabled, np.quiet_hours_start, np.quiet_hours_end,
                  np.quiet_hours_timezone,
                  JSON_EXTRACT(up.prefs_json, '$.gettingStarted') AS gs_json,
                  (EXISTS(SELECT 1 FROM invitations i
                           WHERE i.organization_id = m.organization_id
                             AND i.client_organization_id IS NULL)
                   OR (SELECT COUNT(*) FROM memberships m2
                        WHERE m2.organization_id = m.organization_id
                          AND m2.status = 'active') > 1) AS invite_teammate,
                  EXISTS(SELECT 1 FROM projects p
                          WHERE p.organization_id = m.organization_id) AS create_project,
                  EXISTS(SELECT 1 FROM client_organizations c
                          WHERE c.organization_id = m.organization_id) AS add_client,
                  EXISTS(SELECT 1 FROM storage_connections s
                          WHERE s.organization_id = m.organization_id
                            AND s.status = 'connected') AS connect_storage,
                  EXISTS(SELECT 1 FROM org_working_calendars w
                          WHERE w.organization_id = m.organization_id
                            AND w.scope = 'org') AS set_working_hours,
                  EXISTS(SELECT 1 FROM oauth_grants g
                          WHERE g.organization_id = m.organization_id
                            AND g.user_id = m.user_id
                            AND g.revoked_at IS NULL) AS try_ai_assistant,
                  (SELECT COUNT(*) FROM notifications n
                    WHERE n.organization_id = m.organization_id
                      AND n.recipient_user_id = m.user_id
                      AND n.type = ?
                      AND n.created_at >= ?) AS nudges_today
             FROM memberships m
             LEFT JOIN notification_preferences np
               ON np.organization_id = m.organization_id AND np.user_id = m.user_id
             LEFT JOIN user_preferences up
               ON up.organization_id = m.organization_id AND up.membership_id = m.id
            WHERE m.status = 'active'
              AND m.platform_support_session_id IS NULL
              AND m.created_at >= current_timestamp(3) - INTERVAL ${String(NUDGE_WINDOW_DAYS)} DAY
            ORDER BY m.created_at, m.id
            LIMIT ${String(BATCH)}`,
          [GETTING_STARTED_NUDGE_TYPE, utcMidnight],
        );
        return rows.map(candidateOf);
      }),
    sendNudge: (candidate, _step, dedupeKey) =>
      database.transaction((tx) =>
        insertNotification(tx, {
          organizationId: candidate.organizationId,
          recipientUserId: candidate.userId,
          type: GETTING_STARTED_NUDGE_TYPE,
          objectType: GETTING_STARTED_OBJECT_TYPE,
          objectId: candidate.membershipId,
          dedupeKey,
        }),
      ),
  };
}
