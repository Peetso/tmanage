import type {
  CampaignSenderStore,
  MailboxStats,
  QueuedRecipient,
} from '../../outreach/campaign-sender.js';
import type { WorkerDatabase } from './worker-database.js';

/**
 * LANE-Q (0389) — the SQL behind `outreach/campaign-sender.ts`, as `tmanage_worker` (PART.md W-12:
 * SQL lives here only). Grants (users.sql 0389 block, DA-9: only what the pass needs): SELECT on
 * `outreach_campaigns`; SELECT, UPDATE on `outreach_recipients`; SELECT on `platform_mail_people`,
 * `email_suppressions` and `mail_recipient_bounces` (already granted for the mail lanes).
 *
 * Every statement is a small indexed read or a single-row primary-key write (DA-1). The claim is a
 * compare-and-set from `queued` to `sending`, so two processes that both reached one recipient
 * (the named sweep lock makes this the exception, AS-4) send it once.
 */

export const CAMPAIGN_SQL = {
  running: `SELECT c.id AS id, c.first_started_at AS first_started_at
      FROM outreach_campaigns c WHERE c.status = 'running' AND c.first_started_at IS NOT NULL
     ORDER BY c.created_at ASC, c.id ASC LIMIT 20`,
  // Attempts in the rolling day, per mailbox: the claim stamps `sent_at`, so a refused or dead
  // send counts against the mailbox exactly like a delivered one.
  stats: `SELECT r.sender_person_id AS person_id, COUNT(*) AS attempts, MAX(r.sent_at) AS last_at
      FROM outreach_recipients r
     WHERE r.sent_at IS NOT NULL AND r.sent_at >= ?
     GROUP BY r.sender_person_id`,
  queued: (
    campaigns: number,
  ) => `SELECT r.id AS id, r.campaign_id AS campaign_id, r.company AS company,
       r.first_name AS first_name, r.email_enc AS email_enc, r.email_hash AS email_hash,
       r.country AS country, r.time_zone AS time_zone, r.language AS language,
       r.sender_person_id AS sender_person_id
      FROM outreach_recipients r
     WHERE r.campaign_id IN (${Array.from({ length: campaigns }, () => '?').join(', ')})
       AND r.status = 'queued'
     ORDER BY r.created_at ASC, r.id ASC LIMIT ?`,
  senders: (count: number) => `SELECT p.id AS id, p.name_en AS name_en, p.name_ar AS name_ar,
       p.active AS active
      FROM platform_mail_people p
     WHERE p.id IN (${Array.from({ length: count }, () => '?').join(', ')})`,
  // Unsubscribed from anything, or a bounce still suppressing in any company.
  suppressed: `SELECT 1 AS hit FROM email_suppressions s WHERE s.address_hash = ?
     UNION ALL
     SELECT 1 AS hit FROM mail_recipient_bounces b
      WHERE b.address_hash = ? AND b.suppressed_at IS NOT NULL AND b.cleared_at IS NULL
     LIMIT 1`,
  claim: `UPDATE outreach_recipients SET status = 'sending', sent_at = ?, updated_at = ?
     WHERE id = ? AND status = 'queued'`,
  settle: `UPDATE outreach_recipients SET status = ?, last_error = ?, updated_at = ?
     WHERE id = ? AND status = ?`,
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

export function createCampaignStore(database: WorkerDatabase): CampaignSenderStore {
  return {
    async runningCampaigns() {
      const rows = await database.read((tx) => tx.query<Row[]>(CAMPAIGN_SQL.running));
      return rows.map((row) => ({
        id: String(row['id']),
        firstStartedAt: asDate(row['first_started_at']) ?? new Date(),
      }));
    },

    async mailboxStats(since: Date) {
      const rows = await database.read((tx) => tx.query<Row[]>(CAMPAIGN_SQL.stats, [since]));
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
      return rows.map((row): QueuedRecipient => ({
        id: String(row['id']),
        campaignId: String(row['campaign_id']),
        company: String(row['company']),
        firstName: String(row['first_name']),
        emailEnc: String(row['email_enc']),
        emailHash: String(row['email_hash']),
        country: String(row['country']),
        timeZone: String(row['time_zone']),
        language: row['language'] === 'ar' ? 'ar' : 'en',
        senderPersonId: String(row['sender_person_id']),
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
          active: row['active'] === true || Number(row['active']) === 1,
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

    async claim(id: string, at: Date) {
      const result = await database.transaction((tx) => tx.query(CAMPAIGN_SQL.claim, [at, at, id]));
      return affected(result) === 1;
    },

    async settle(id, from, to, at, error) {
      await database.transaction((tx) =>
        tx.query(CAMPAIGN_SQL.settle, [to, error ?? null, at, id, from]),
      );
    },
  };
}
