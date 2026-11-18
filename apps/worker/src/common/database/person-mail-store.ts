import {
  PERSONAL_PROBES,
  WORKSPACE_PROBES,
  type FeatureNewsNote,
  type PersonalProbe,
  type WorkspaceProbe,
} from '../../notifications/person-mail-catalog.js';
import {
  NEWS_DELIVERY_DAYS,
  type MemberFactsPart,
  type PersonMailCandidate,
  type PersonMailStore,
  type WorkspaceFactsPart,
} from '../../jobs/person-mail-sweep.js';
import type { WorkerDatabase, WorkerTransaction } from './worker-database.js';

/**
 * EMAILBUILD2 — the person-mail sweep's reads and writes. Indexed lookups only:
 *
 * - candidates: `memberships` by `ix_memberships_user` after the cursor, joined to their user and
 *   workspace by primary key, 100 rows;
 * - workspace facts: ONE statement per workspace per run — each "used?" probe is a
 *   `(SELECT … WHERE organization_id = ? LIMIT 1)` on the table's leading `organization_id` index;
 *   the member count, open invitations, ten files (an index range of 10 rows), the sign-in policy
 *   row and the newest member session ride along as scalar sub-selects;
 * - member facts: ONE statement for the personal probes (each on its `(organization_id, user or
 *   membership)` index), one for the scalars, one for the member's tip log (primary-key prefix);
 * - the claim: `INSERT IGNORE` on the tip log's primary key (status 'sending', attempt 1);
 * - MAILREST (0374): due retries by `ix_mail_tip_log_retry (status, next_attempt_at)`, 25 rows,
 *   joined to the member with the candidate filters; the re-claim and the settle are guarded
 *   `UPDATE`s on the primary key (`status` and `attempts` in the WHERE), so only one run owns
 *   an attempt.
 *
 * Table names come from the catalog's fixed probe lists, never from input. Grants (users.sql):
 * SELECT on every probed table, `notification_kind_prefs`, `platform_feature_news`,
 * `platform_settings`, `credential_change_notices`, `sessions`, `invitations`, `org_policies`;
 * SELECT, INSERT, UPDATE on `mail_tip_log` (UPDATE new in 0374); SELECT, UPDATE on
 * `platform_person_mail_sweep`.
 */

const TIPS_SWITCH_KEY = 'mail.tips_enabled';

function workspaceProbeSql(): string {
  return (Object.entries(WORKSPACE_PROBES) as [WorkspaceProbe, string][])
    .map(([id, table]) => `(SELECT '${id}' AS f FROM ${table} WHERE organization_id = ? LIMIT 1)`)
    .join(' UNION ALL ');
}

function personalProbeSql(): string {
  return (
    Object.entries(PERSONAL_PROBES) as [PersonalProbe, (typeof PERSONAL_PROBES)[PersonalProbe]][]
  )
    .map(
      ([id, probe]) =>
        `(SELECT '${id}' AS f FROM ${probe.table} WHERE organization_id = ? AND ${probe.by} = ? LIMIT 1)`,
    )
    .join(' UNION ALL ');
}

export const PERSON_MAIL_SQL = {
  switch: `SELECT setting_value AS value FROM platform_settings WHERE setting_key = ? LIMIT 1`,
  cursor: `SELECT cursor_user_id AS cursor_user_id FROM platform_person_mail_sweep WHERE id = 1`,
  writeCursor: `UPDATE platform_person_mail_sweep SET cursor_user_id = ?, last_run_at = ? WHERE id = 1`,
  candidates: `SELECT m.organization_id AS organization_id, m.id AS membership_id,
         m.user_id AS user_id, m.role AS role, u.email AS email, u.display_name AS display_name,
         u.locale AS locale, o.slug AS slug, o.name AS workspace_name
    FROM memberships m
    JOIN users u ON u.id = m.user_id
    JOIN organizations o ON o.id = m.organization_id
   WHERE m.user_id > ?
     AND m.status = 'active' AND m.platform_support_session_id IS NULL
     AND u.disabled_at IS NULL AND u.email_verified_at IS NOT NULL
     AND o.archived_at IS NULL AND o.suspended_at IS NULL AND o.deleted_at IS NULL
   ORDER BY m.user_id, m.organization_id
   LIMIT ?`,
  news: `SELECT id, title_en, title_ar, body_en, body_ar, link FROM platform_feature_news
   WHERE sent_at IS NOT NULL AND sent_at > ? ORDER BY sent_at ASC, id ASC LIMIT 20`,
  workspaceProbes: workspaceProbeSql(),
  workspaceScalars: `SELECT o.created_at AS created_at,
      (SELECT COUNT(*) FROM memberships m WHERE m.organization_id = o.id AND m.status = 'active'
          AND m.platform_support_session_id IS NULL) AS active_members,
      (SELECT COUNT(*) FROM invitations i WHERE i.organization_id = o.id AND i.status = 'pending'
          AND i.client_organization_id IS NULL) AS open_invitations,
      (SELECT COUNT(*) FROM (SELECT 1 FROM file_assets f WHERE f.organization_id = ? LIMIT 10) ten)
          AS files_upto_ten,
      (SELECT COUNT(*) FROM org_policies p WHERE p.organization_id = o.id) AS policies,
      (SELECT MAX(s.created_at) FROM memberships mm JOIN sessions s ON s.user_id = mm.user_id
        WHERE mm.organization_id = o.id AND mm.status = 'active') AS last_sign_in
    FROM organizations o WHERE o.id = ? LIMIT 1`,
  personalProbes: personalProbeSql(),
  memberScalars: `SELECT m.created_at AS joined_at, u.timezone AS timezone,
      (SELECT COUNT(*) FROM invitations i WHERE i.organization_id = m.organization_id
          AND i.invited_by_user_id = m.user_id AND i.status = 'pending'
          AND i.client_organization_id IS NULL AND i.created_at < ?) AS stale_invitations,
      (SELECT MAX(s.created_at) FROM sessions s WHERE s.user_id = m.user_id) AS last_sign_in,
      (SELECT MAX(n.occurred_at) FROM credential_change_notices n WHERE n.user_id = m.user_id
          AND n.action = 'new_device_sign_in' AND n.occurred_at > ?) AS new_device_at,
      (SELECT k.enabled FROM notification_kind_prefs k WHERE k.organization_id = m.organization_id
          AND k.membership_id = m.id AND k.kind = 'tips' LIMIT 1) AS tips_enabled
    FROM memberships m JOIN users u ON u.id = m.user_id
   WHERE m.organization_id = ? AND m.id = ? LIMIT 1`,
  tipLog: `SELECT tip_id, sent_at FROM mail_tip_log WHERE organization_id = ? AND user_id = ?`,
  claim: `INSERT IGNORE INTO mail_tip_log
     (organization_id, user_id, tip_id, sent_at, status, attempts)
   VALUES (?, ?, ?, ?, 'sending', 1)`,
  dueRetries: `SELECT t.organization_id AS organization_id, t.user_id AS user_id, t.tip_id AS tip_id,
         t.attempts AS attempts, m.id AS membership_id, m.role AS role, u.email AS email,
         u.display_name AS display_name, u.locale AS locale, o.slug AS slug,
         o.name AS workspace_name
    FROM mail_tip_log t
    JOIN memberships m ON m.organization_id = t.organization_id AND m.user_id = t.user_id
    JOIN users u ON u.id = t.user_id
    JOIN organizations o ON o.id = t.organization_id
   WHERE t.status = 'retry' AND t.next_attempt_at <= ?
     AND m.status = 'active' AND m.platform_support_session_id IS NULL
     AND u.disabled_at IS NULL AND u.email_verified_at IS NOT NULL
     AND o.archived_at IS NULL AND o.suspended_at IS NULL AND o.deleted_at IS NULL
   ORDER BY t.next_attempt_at ASC
   LIMIT ?`,
  reclaim: `UPDATE mail_tip_log SET status = 'sending', attempts = attempts + 1, next_attempt_at = NULL
   WHERE organization_id = ? AND user_id = ? AND tip_id = ? AND status = 'retry' AND attempts = ?`,
  settle: `UPDATE mail_tip_log
     SET status = ?, next_attempt_at = ?, last_error = ?, sent_at = COALESCE(?, sent_at)
   WHERE organization_id = ? AND user_id = ? AND tip_id = ? AND status = 'sending' AND attempts = ?`,
} as const;

interface CandidateRow {
  readonly organization_id: string;
  readonly membership_id: string;
  readonly user_id: string;
  readonly role: string;
  readonly email: string;
  readonly display_name: string | null;
  readonly locale: string | null;
  readonly slug: string;
  readonly workspace_name: string;
}

interface RetryRow extends CandidateRow {
  readonly tip_id: string;
  readonly attempts: number | string;
}

interface WorkspaceScalarRow {
  readonly created_at: Date | string;
  readonly active_members: number | string;
  readonly open_invitations: number | string;
  readonly files_upto_ten: number | string;
  readonly policies: number | string;
  readonly last_sign_in: Date | string | null;
}

interface MemberScalarRow {
  readonly joined_at: Date | string;
  readonly timezone: string | null;
  readonly stale_invitations: number | string;
  readonly last_sign_in: Date | string | null;
  readonly new_device_at: Date | string | null;
  readonly tips_enabled: number | boolean | null;
}

interface NewsRow {
  readonly id: string;
  readonly title_en: string;
  readonly title_ar: string;
  readonly body_en: string;
  readonly body_ar: string;
  readonly link: string;
}

const toDate = (value: Date | string): Date => (value instanceof Date ? value : new Date(value));
const toDateOrNull = (value: Date | string | null): Date | null =>
  value === null ? null : toDate(value);

const isWorkspaceProbe = (value: string): value is WorkspaceProbe =>
  Object.hasOwn(WORKSPACE_PROBES, value);
const isPersonalProbe = (value: string): value is PersonalProbe =>
  Object.hasOwn(PERSONAL_PROBES, value);

function candidateOf(row: CandidateRow): PersonMailCandidate {
  return {
    organizationId: row.organization_id,
    membershipId: row.membership_id,
    userId: row.user_id,
    role: row.role,
    email: row.email,
    displayName: row.display_name ?? '',
    locale: row.locale,
    slug: row.slug,
    workspaceName: row.workspace_name,
  };
}

async function rows<T>(tx: WorkerTransaction, sql: string, params: readonly unknown[]) {
  return tx.query<readonly T[]>(sql, params);
}

export function createPersonMailStore(database: WorkerDatabase): PersonMailStore {
  return {
    async tipsSwitchOn() {
      const found = await database.read((tx) =>
        rows<{ value: string }>(tx, PERSON_MAIL_SQL.switch, [TIPS_SWITCH_KEY]),
      );
      return found[0]?.value === 'on';
    },
    async readCursor() {
      const found = await database.read((tx) =>
        rows<{ cursor_user_id: string | null }>(tx, PERSON_MAIL_SQL.cursor, []),
      );
      return found[0]?.cursor_user_id ?? null;
    },
    async writeCursor(userId, at) {
      await database.transaction((tx) => tx.query(PERSON_MAIL_SQL.writeCursor, [userId, at]));
    },
    async listCandidates(afterUserId, limit) {
      const found = await database.read((tx) =>
        rows<CandidateRow>(tx, PERSON_MAIL_SQL.candidates, [afterUserId ?? '', limit]),
      );
      return found.map(candidateOf);
    },
    async publishedNews(now) {
      const since = new Date(now.getTime() - NEWS_DELIVERY_DAYS * 86_400_000);
      const found = await database.read((tx) => rows<NewsRow>(tx, PERSON_MAIL_SQL.news, [since]));
      return found.map((row): FeatureNewsNote => ({
        id: row.id,
        titleEn: row.title_en,
        titleAr: row.title_ar,
        bodyEn: row.body_en,
        bodyAr: row.body_ar,
        link: row.link,
      }));
    },
    async workspaceFacts(organizationId) {
      return database.read(async (tx) => {
        const probes = await rows<{ f: string }>(
          tx,
          PERSON_MAIL_SQL.workspaceProbes,
          Object.keys(WORKSPACE_PROBES).map(() => organizationId),
        );
        const scalar = (
          await rows<WorkspaceScalarRow>(tx, PERSON_MAIL_SQL.workspaceScalars, [
            organizationId,
            organizationId,
          ])
        )[0];
        const used = new Set<WorkspaceProbe>();
        for (const probe of probes) if (isWorkspaceProbe(probe.f)) used.add(probe.f);
        const part: WorkspaceFactsPart = {
          workspaceCreatedAt: scalar === undefined ? new Date() : toDate(scalar.created_at),
          activeMembers: Number(scalar?.active_members ?? 0),
          openTeamInvitations: Number(scalar?.open_invitations ?? 0),
          workspaceUsed: used,
          tenFiles: Number(scalar?.files_upto_ten ?? 0) >= 10,
          hasSignInPolicy: Number(scalar?.policies ?? 0) > 0,
          workspaceLastSignInAt: toDateOrNull(scalar?.last_sign_in ?? null),
        };
        return part;
      });
    },
    async memberFacts(candidate, now) {
      return database.read(async (tx) => {
        const params: unknown[] = [];
        for (const probe of Object.values(PERSONAL_PROBES)) {
          params.push(
            candidate.organizationId,
            probe.by === 'membership_id' ? candidate.membershipId : candidate.userId,
          );
        }
        const probes = await rows<{ f: string }>(tx, PERSON_MAIL_SQL.personalProbes, params);
        const staleBefore = new Date(now.getTime() - 3 * 86_400_000);
        const deviceSince = new Date(now.getTime() - 7 * 86_400_000);
        const scalar = (
          await rows<MemberScalarRow>(tx, PERSON_MAIL_SQL.memberScalars, [
            staleBefore,
            deviceSince,
            candidate.organizationId,
            candidate.membershipId,
          ])
        )[0];
        const log = await rows<{ tip_id: string; sent_at: Date | string }>(
          tx,
          PERSON_MAIL_SQL.tipLog,
          [candidate.organizationId, candidate.userId],
        );
        const used = new Set<PersonalProbe>();
        for (const probe of probes) if (isPersonalProbe(probe.f)) used.add(probe.f);
        const tips = scalar?.tips_enabled ?? null;
        const part: MemberFactsPart = {
          joinedAt: scalar === undefined ? now : toDate(scalar.joined_at),
          ownStaleInvitations: Number(scalar?.stale_invitations ?? 0),
          personalUsed: used,
          userLastSignInAt: toDateOrNull(scalar?.last_sign_in ?? null),
          newDeviceNoticeAt: toDateOrNull(scalar?.new_device_at ?? null),
          profileTimezoneSet: (scalar?.timezone ?? '') !== '',
          sent: new Map(log.map((row) => [row.tip_id, toDate(row.sent_at)])),
          tipsEnabled: tips === null || tips === true || Number(tips) === 1,
        };
        return part;
      });
    },
    async claim(candidate, tipId, at) {
      const result = await database.transaction((tx) =>
        tx.query<{ affectedRows?: number }>(PERSON_MAIL_SQL.claim, [
          candidate.organizationId,
          candidate.userId,
          tipId,
          at,
        ]),
      );
      return result.affectedRows === 1;
    },
    async dueRetries(now, limit) {
      const found = await database.read((tx) =>
        rows<RetryRow>(tx, PERSON_MAIL_SQL.dueRetries, [now, limit]),
      );
      return found.map((row) => ({
        candidate: candidateOf(row),
        tipId: row.tip_id,
        attempts: Number(row.attempts),
      }));
    },
    async reclaim(retry) {
      const result = await database.transaction((tx) =>
        tx.query<{ affectedRows?: number }>(PERSON_MAIL_SQL.reclaim, [
          retry.candidate.organizationId,
          retry.candidate.userId,
          retry.tipId,
          retry.attempts,
        ]),
      );
      return result.affectedRows === 1;
    },
    async settle(candidate, tipId, attempts, outcome, at) {
      await database.transaction((tx) =>
        tx.query(PERSON_MAIL_SQL.settle, [
          outcome.status,
          outcome.status === 'retry' ? outcome.nextAttemptAt : null,
          outcome.status === 'sent' ? null : outcome.error.slice(0, 32),
          outcome.status === 'sent' ? at : null,
          candidate.organizationId,
          candidate.userId,
          tipId,
          attempts,
        ]),
      );
    },
  };
}
