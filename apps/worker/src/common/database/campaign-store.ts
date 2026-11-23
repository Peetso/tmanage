import { isCampaignLanguage } from '@tmanage/mail';
import type { CampaignLanguage } from '@tmanage/mail';
import type {
  CampaignSenderStore,
  CampaignVersion,
  FollowupCandidate,
  MailboxStats,
  QueuedRecipient,
} from '../../outreach/campaign-sender.js';
import type { WorkerDatabase } from './worker-database.js';

/**
 * LANE-Q (0389) / OUTREACH MANAGER (0409) — the SQL behind `outreach/campaign-sender.ts`, as
 * `tmanage_worker` (PART.md W-12: SQL lives here only). Grants (users.sql 0389 and 0409 blocks,
 * DA-9: only what the pass needs): SELECT on `outreach_campaigns`, `outreach_email_versions` and
 * `outreach_campaign_senders`; SELECT, UPDATE on `outreach_recipients`; SELECT on
 * `platform_mail_people`, `email_suppressions` and `mail_recipient_bounces` (already granted for
 * the mail lanes).
 *
 * Every statement is a small indexed read or a single-row primary-key write (DA-1). The claim is a
 * compare-and-set from `queued` to `sending`, so two processes that both reached one recipient
 * (the named sweep lock makes this the exception, AS-4) send it once.
 */

const list = (count: number): string => Array.from({ length: count }, () => '?').join(', ');

const RECIPIENT_COLUMNS = `r.id AS id, r.campaign_id AS campaign_id, r.company AS company,
       r.first_name AS first_name, r.email_enc AS email_enc, r.email_hash AS email_hash,
       r.country AS country, r.time_zone AS time_zone, r.language AS language,
       r.sender_person_id AS sender_person_id`;

export const CAMPAIGN_SQL = {
  running: `SELECT c.id AS id, c.first_started_at AS first_started_at, c.daily_cap AS daily_cap,
       c.warmup AS warmup, c.followup_enabled AS followup_enabled,
       c.followup_days AS followup_days, c.sender_pool AS sender_pool
      FROM outreach_campaigns c
     WHERE c.status = 'running' AND c.archived_at IS NULL AND c.first_started_at IS NOT NULL
     ORDER BY c.created_at ASC, c.id ASC LIMIT 20`,
  // The newest version per (campaign, kind, language): versions are never updated, so the
  // highest number is the one saved last (uq_outreach_email_versions leads with campaign_id).
  versions: (campaigns: number) => `SELECT v.campaign_id AS campaign_id, v.kind AS kind,
       v.language AS language, v.version AS version, v.subject AS subject, v.body AS body
      FROM outreach_email_versions v
      JOIN (SELECT m.campaign_id AS campaign_id, m.kind AS kind, m.language AS language,
                   MAX(m.version) AS version
              FROM outreach_email_versions m
             WHERE m.campaign_id IN (${list(campaigns)})
             GROUP BY m.campaign_id, m.kind, m.language) newest
        ON newest.campaign_id = v.campaign_id AND newest.kind = v.kind
       AND newest.language = v.language AND newest.version = v.version`,
  chosen: (campaigns: number) => `SELECT s.campaign_id AS campaign_id, s.person_id AS person_id
      FROM outreach_campaign_senders s WHERE s.campaign_id IN (${list(campaigns)})`,
  // Attempts in the rolling day, per mailbox, introductions and follow-ups together: the claims
  // stamp `sent_at` / `followup_sent_at`, so a refused or dead send counts against the mailbox
  // exactly like a delivered one.
  stats: `SELECT t.person_id AS person_id, COUNT(*) AS attempts, MAX(t.at) AS last_at
      FROM (SELECT r.sender_person_id AS person_id, r.sent_at AS at
              FROM outreach_recipients r WHERE r.sent_at IS NOT NULL AND r.sent_at >= ?
            UNION ALL
            SELECT f.sender_person_id AS person_id, f.followup_sent_at AS at
              FROM outreach_recipients f
             WHERE f.followup_sent_at IS NOT NULL AND f.followup_sent_at >= ?) t
     GROUP BY t.person_id`,
  queued: (campaigns: number) => `SELECT ${RECIPIENT_COLUMNS}
      FROM outreach_recipients r
     WHERE r.campaign_id IN (${list(campaigns)})
       AND r.status = 'queued'
     ORDER BY r.created_at ASC, r.id ASC LIMIT ?`,
  // ix_outreach_recipients_followup (campaign_id, status, followup_status).
  followups: (campaigns: number) => `SELECT ${RECIPIENT_COLUMNS}, r.sent_at AS sent_at
      FROM outreach_recipients r
     WHERE r.campaign_id IN (${list(campaigns)})
       AND r.status = 'sent' AND r.followup_status IS NULL AND r.sent_at IS NOT NULL
       AND r.replied_at IS NULL AND r.trial_redeemed_at IS NULL AND r.walkthrough_at IS NULL
     ORDER BY r.sent_at ASC, r.id ASC LIMIT ?`,
  senders: (count: number) => `SELECT p.id AS id, p.name_en AS name_en, p.name_ar AS name_ar,
       p.active AS active
      FROM platform_mail_people p
     WHERE p.id IN (${list(count)})`,
  // Unsubscribed from anything, or a bounce still suppressing in any company.
  suppressed: `SELECT 1 AS hit FROM email_suppressions s WHERE s.address_hash = ?
     UNION ALL
     SELECT 1 AS hit FROM mail_recipient_bounces b
      WHERE b.address_hash = ? AND b.suppressed_at IS NOT NULL AND b.cleared_at IS NULL
     LIMIT 1`,
  claim: `UPDATE outreach_recipients SET status = 'sending', sent_at = ?, intro_version = ?,
       updated_at = ?
     WHERE id = ? AND status = 'queued'`,
  settle: `UPDATE outreach_recipients SET status = ?, last_error = ?, updated_at = ?
     WHERE id = ? AND status = ?`,
  claimFollowup: `UPDATE outreach_recipients SET followup_status = 'sending', followup_sent_at = ?,
       followup_version = ?, updated_at = ?
     WHERE id = ? AND status = 'sent' AND followup_status IS NULL`,
  // `<=>` is the null-safe equality of MySQL and MariaDB: from NULL (skipped) or from `sending`.
  settleFollowup: `UPDATE outreach_recipients SET followup_status = ?, followup_error = ?,
       updated_at = ?
     WHERE id = ? AND followup_status <=> ?`,
} as const;

type Row = Readonly<Record<string, unknown>>;

const affected = (result: unknown): number => {
  const header = Array.isArray(result) ? result[0] : result;
  return Number((header as { affectedRows?: number } | undefined)?.affectedRows ?? 0);
};

const asDate = (value: unknown): Date | null =>
  value === null || value === undefined
    ? null
    : value instanceof Date
      ? value
      : new Date(String(value));

const flag = (value: unknown): boolean => value === true || Number(value) === 1;

const languageOf = (value: unknown): CampaignLanguage => (isCampaignLanguage(value) ? value : 'en');

function toRecipient(row: Row): QueuedRecipient {
  return {
    id: String(row['id']),
    campaignId: String(row['campaign_id']),
    company: String(row['company']),
    firstName: String(row['first_name']),
    emailEnc: String(row['email_enc']),
    emailHash: String(row['email_hash']),
    country: String(row['country']),
    timeZone: String(row['time_zone']),
    language: languageOf(row['language']),
    senderPersonId: String(row['sender_person_id']),
  };
}

export function createCampaignStore(database: WorkerDatabase): CampaignSenderStore {
  return {
    async runningCampaigns() {
      const rows = await database.read((tx) => tx.query<Row[]>(CAMPAIGN_SQL.running));
      return rows.map((row) => ({
        id: String(row['id']),
        firstStartedAt: asDate(row['first_started_at']) ?? new Date(),
        dailyCap: Number(row['daily_cap'] ?? 20),
        warmup: flag(row['warmup']),
        followupEnabled: flag(row['followup_enabled']),
        followupDays: Number(row['followup_days'] ?? 4),
        senderPool: row['sender_pool'] === 'chosen' ? ('chosen' as const) : ('auto' as const),
      }));
    },

    async versions(campaignIds: readonly string[]) {
      if (campaignIds.length === 0) return [];
      const rows = await database.read((tx) =>
        tx.query<Row[]>(CAMPAIGN_SQL.versions(campaignIds.length), [...campaignIds]),
      );
      const found: CampaignVersion[] = [];
      for (const row of rows) {
        const kind = row['kind'];
        const language = row['language'];
        if ((kind !== 'intro' && kind !== 'followup') || !isCampaignLanguage(language)) continue;
        found.push({
          campaignId: String(row['campaign_id']),
          kind,
          language,
          version: Number(row['version']),
          text: { subject: String(row['subject']), body: String(row['body']) },
        });
      }
      return found;
    },

    async chosenSenders(campaignIds: readonly string[]) {
      const found = new Map<string, Set<string>>();
      if (campaignIds.length === 0) return found;
      const rows = await database.read((tx) =>
        tx.query<Row[]>(CAMPAIGN_SQL.chosen(campaignIds.length), [...campaignIds]),
      );
      for (const row of rows) {
        const id = String(row['campaign_id']);
        const set = found.get(id) ?? new Set<string>();
        set.add(String(row['person_id']));
        found.set(id, set);
      }
      return found;
    },

    async mailboxStats(since: Date) {
      const rows = await database.read((tx) => tx.query<Row[]>(CAMPAIGN_SQL.stats, [since, since]));
      const stats = new Map<string, MailboxStats>();
      for (const row of rows) {
        stats.set(String(row['person_id']), {
          attempts24h: Number(row['attempts']),
          lastAttemptAt: asDate(row['last_at']),
        });
      }
      return stats;
    },

    async queued(campaignIds: readonly string[], limit: number) {
      if (campaignIds.length === 0) return [];
      const rows = await database.read((tx) =>
        tx.query<Row[]>(CAMPAIGN_SQL.queued(campaignIds.length), [...campaignIds, limit]),
      );
      return rows.map(toRecipient);
    },

    async followupCandidates(campaignIds: readonly string[], limit: number) {
      if (campaignIds.length === 0) return [];
      const rows = await database.read((tx) =>
        tx.query<Row[]>(CAMPAIGN_SQL.followups(campaignIds.length), [...campaignIds, limit]),
      );
      return rows.map((row): FollowupCandidate => ({
        ...toRecipient(row),
        sentAt: asDate(row['sent_at']) ?? new Date(0),
      }));
    },

    async senders(personIds: readonly string[]) {
      const found = new Map<string, { nameEn: string; nameAr: string; active: boolean }>();
      if (personIds.length === 0) return found;
      const rows = await database.read((tx) =>
        tx.query<Row[]>(CAMPAIGN_SQL.senders(personIds.length), [...personIds]),
      );
      for (const row of rows) {
        found.set(String(row['id']), {
          nameEn: String(row['name_en']),
          nameAr: String(row['name_ar']),
          active: flag(row['active']),
        });
      }
      return found;
    },

    async isSuppressed(emailHash: string) {
      const rows = await database.read((tx) =>
        tx.query<Row[]>(CAMPAIGN_SQL.suppressed, [emailHash, emailHash]),
      );
      return rows.length > 0;
    },

    async claim(id: string, at: Date, version: number | null) {
      const result = await database.transaction((tx) =>
        tx.query(CAMPAIGN_SQL.claim, [at, version, at, id]),
      );
      return affected(result) === 1;
    },

    async settle(id, from, to, at, error) {
      await database.transaction((tx) =>
        tx.query(CAMPAIGN_SQL.settle, [to, error ?? null, at, id, from]),
      );
    },

    async claimFollowup(id: string, at: Date, version: number | null) {
      const result = await database.transaction((tx) =>
        tx.query(CAMPAIGN_SQL.claimFollowup, [at, version, at, id]),
      );
      return affected(result) === 1;
    },

    async settleFollowup(id, from, to, at, error) {
      await database.transaction((tx) =>
        tx.query(CAMPAIGN_SQL.settleFollowup, [to, error ?? null, at, id, from]),
      );
    },
  };
}
