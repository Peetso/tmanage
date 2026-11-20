import type { RowDataPacket } from 'mysql2';
import type { IdentityQueryRunner, TenantDatabase } from '../../common/database/tenant-context.js';
import type {
  OutreachCampaignStatus,
  OutreachRecipientStatus,
} from '../../common/database/schema.js';
import type { PlatformAuditInput } from '../platform-admin/platform-admin.repository.js';
import { insertPlatformAudit } from '../platform-admin/platform-audit.service.js';
import type { OutreachSender } from './outreach-import.js';

/**
 * LANE-Q (0389) — every API statement on the outreach tables (IP-5: one repository, the SQL in
 * one place). Both tables are global platform tables, reached on the identity path; every platform
 * write carries its audit row in the same transaction. The worker's statements live in
 * `apps/worker/src/common/database/campaign-store.ts`.
 */

export interface CampaignRecord {
  readonly id: string;
  readonly name: string;
  readonly status: OutreachCampaignStatus;
  readonly firstStartedAt: Date | null;
  readonly createdAt: Date;
}

export interface RecipientInsert {
  readonly id: string;
  readonly campaignId: string;
  readonly company: string;
  readonly personName: string;
  readonly firstName: string;
  readonly emailEnc: string;
  readonly emailHash: string;
  readonly country: string;
  readonly timeZone: string;
  readonly language: 'en' | 'ar';
  readonly senderPersonId: string;
}

export interface RecipientSummary {
  readonly id: string;
  readonly campaignId: string;
  readonly company: string;
  readonly firstName: string;
  readonly country: string;
  readonly language: string;
  readonly senderAddress: string | null;
  readonly status: OutreachRecipientStatus;
  readonly sentAt: Date | null;
  readonly trialRedeemedAt: Date | null;
}

/** What the trial-link door needs about one recipient. */
export interface TrialRecipient {
  readonly id: string;
  readonly company: string;
  readonly emailEnc: string;
  readonly language: string;
  readonly redeemed: boolean;
}

/** The newest campaigns the page lists; the recipients of the newest one are listed in full. */
export const MAX_LISTED_CAMPAIGNS = 20;
export const MAX_LISTED_RECIPIENTS = 2000;

const TABLES = ['outreach_campaigns', 'outreach_recipients'] as const;

export const OUTREACH_SQL = {
  senders: `SELECT p.id AS id, p.address AS address FROM platform_mail_people p
     WHERE p.active = 1 ORDER BY p.address ASC LIMIT 500`,
  known: `SELECT r.email_hash AS email_hash, r.company AS company FROM outreach_recipients r
     LIMIT 100000`,
  insertCampaign: `INSERT INTO outreach_campaigns
     (id, name, status, first_started_at, created_by, created_at, updated_at)
     VALUES (?, ?, 'paused', NULL, ?, ?, ?)`,
  insertRecipient: `INSERT INTO outreach_recipients
     (id, campaign_id, company, person_name, first_name, email_enc, email_hash, country,
      time_zone, language, sender_person_id, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?)`,
  campaigns: `SELECT c.id AS id, c.name AS name, c.status AS status,
       c.first_started_at AS first_started_at, c.created_at AS created_at
     FROM outreach_campaigns c ORDER BY c.created_at DESC, c.id DESC LIMIT ${String(MAX_LISTED_CAMPAIGNS)}`,
  campaignById: `SELECT c.id AS id, c.name AS name, c.status AS status,
       c.first_started_at AS first_started_at, c.created_at AS created_at
     FROM outreach_campaigns c WHERE c.id = ? LIMIT 1`,
  counts: `SELECT r.campaign_id AS campaign_id, r.status AS status, COUNT(*) AS n,
       SUM(CASE WHEN r.trial_redeemed_at IS NULL THEN 0 ELSE 1 END) AS redeemed
     FROM outreach_recipients r GROUP BY r.campaign_id, r.status`,
  recipients: `SELECT r.id AS id, r.campaign_id AS campaign_id, r.company AS company,
       r.first_name AS first_name, r.country AS country, r.language AS language,
       p.address AS sender_address, r.status AS status, r.sent_at AS sent_at,
       r.trial_redeemed_at AS trial_redeemed_at
     FROM outreach_recipients r LEFT JOIN platform_mail_people p ON p.id = r.sender_person_id
     WHERE r.campaign_id = ? ORDER BY r.created_at ASC, r.id ASC LIMIT ${String(MAX_LISTED_RECIPIENTS)}`,
  setStatus: `UPDATE outreach_campaigns SET status = ?,
       first_started_at = CASE WHEN ? = 'running' AND first_started_at IS NULL THEN ? ELSE first_started_at END,
       updated_at = ?
     WHERE id = ? AND status = ?`,
  recipientHash: `SELECT r.email_hash AS email_hash, r.status AS status FROM outreach_recipients r
     WHERE r.id = ? LIMIT 1`,
  markBounced: `UPDATE outreach_recipients SET status = 'bounced', updated_at = ? WHERE id = ?`,
  suppress: `INSERT INTO email_suppressions (address_hash, scope, reason, created_at, updated_at)
     VALUES (?, 'notifications', 'bounced', ?, ?)
     ON DUPLICATE KEY UPDATE reason = 'bounced', updated_at = ?`,
  trialRecipient: `SELECT r.id AS id, r.company AS company, r.email_enc AS email_enc,
       r.language AS language, r.trial_redeemed_at AS trial_redeemed_at
     FROM outreach_recipients r WHERE r.id = ? LIMIT 1`,
  redeem: `UPDATE outreach_recipients SET trial_redeemed_at = ?, trial_user_id = ?, updated_at = ?
     WHERE id = ? AND trial_redeemed_at IS NULL`,
} as const;

type Row = RowDataPacket & Record<string, unknown>;

const date = (value: unknown): Date | null =>
  value === null || value === undefined ? null : new Date(value as string | Date);

function toCampaign(row: Row): CampaignRecord {
  return {
    id: String(row['id']),
    name: String(row['name']),
    status: String(row['status']) as OutreachCampaignStatus,
    firstStartedAt: date(row['first_started_at']),
    createdAt: date(row['created_at']) ?? new Date(0),
  };
}

/** Rows a write touched (mysql2 answers a header, or `[header, fields]` through some paths). */
function affected(result: unknown): number {
  const header = Array.isArray(result) ? (result[0] as unknown) : result;
  const rows = (header as { affectedRows?: unknown } | null)?.affectedRows;
  return typeof rows === 'number' ? rows : 0;
}

export interface CampaignCounts {
  readonly byStatus: Readonly<Record<string, number>>;
  readonly redeemed: number;
}

export class OutreachRepository {
  constructor(private readonly database: TenantDatabase) {}

  activeSenders(correlationId: string): Promise<readonly OutreachSender[]> {
    return this.database.identityRead(
      { correlationId, tables: ['platform_mail_people'] },
      async (db) =>
        (await db.query<Row[]>(OUTREACH_SQL.senders)).map((row) => ({
          id: String(row['id']),
          address: String(row['address']),
        })),
    );
  }

  known(correlationId: string): Promise<{ hashes: Set<string>; companies: string[] }> {
    return this.database.identityRead({ correlationId, tables: [...TABLES] }, async (db) => {
      const rows = await db.query<Row[]>(OUTREACH_SQL.known);
      return {
        hashes: new Set(rows.map((row) => String(row['email_hash']))),
        companies: rows.map((row) => String(row['company'])),
      };
    });
  }

  /** The campaign, its recipients and the audit row, in one transaction. */
  async insertCampaign(
    campaign: { id: string; name: string; createdBy: string; at: Date },
    recipients: readonly RecipientInsert[],
    audit: PlatformAuditInput,
  ): Promise<void> {
    await this.database.identityTransaction(
      { correlationId: audit.correlationId, tables: [...TABLES, 'platform_admin_audit_events'] },
      async (tx) => {
        await tx.query(OUTREACH_SQL.insertCampaign, [
          campaign.id,
          campaign.name,
          campaign.createdBy,
          campaign.at,
          campaign.at,
        ]);
        for (const r of recipients) {
          await tx.query(OUTREACH_SQL.insertRecipient, [
            r.id,
            r.campaignId,
            r.company,
            r.personName,
            r.firstName,
            r.emailEnc,
            r.emailHash,
            r.country,
            r.timeZone,
            r.language,
            r.senderPersonId,
            campaign.at,
            campaign.at,
          ]);
        }
        await insertPlatformAudit(tx, audit);
      },
    );
  }

  campaigns(correlationId: string): Promise<readonly CampaignRecord[]> {
    return this.database.identityRead({ correlationId, tables: [...TABLES] }, async (db) =>
      (await db.query<Row[]>(OUTREACH_SQL.campaigns)).map(toCampaign),
    );
  }

  campaign(id: string, correlationId: string): Promise<CampaignRecord | null> {
    return this.database.identityRead({ correlationId, tables: [...TABLES] }, async (db) => {
      const row = (await db.query<Row[]>(OUTREACH_SQL.campaignById, [id]))[0];
      return row === undefined ? null : toCampaign(row);
    });
  }

  counts(correlationId: string): Promise<ReadonlyMap<string, CampaignCounts>> {
    return this.database.identityRead({ correlationId, tables: [...TABLES] }, async (db) => {
      const map = new Map<string, { byStatus: Record<string, number>; redeemed: number }>();
      for (const row of await db.query<Row[]>(OUTREACH_SQL.counts)) {
        const id = String(row['campaign_id']);
        const entry = map.get(id) ?? { byStatus: {}, redeemed: 0 };
        entry.byStatus[String(row['status'])] = Number(row['n']);
        entry.redeemed += Number(row['redeemed'] ?? 0);
        map.set(id, entry);
      }
      return map;
    });
  }

  recipients(campaignId: string, correlationId: string): Promise<readonly RecipientSummary[]> {
    return this.database.identityRead(
      { correlationId, tables: [...TABLES, 'platform_mail_people'] },
      async (db) =>
        (await db.query<Row[]>(OUTREACH_SQL.recipients, [campaignId])).map((row) => ({
          id: String(row['id']),
          campaignId: String(row['campaign_id']),
          company: String(row['company']),
          firstName: String(row['first_name']),
          country: String(row['country']),
          language: String(row['language']),
          senderAddress: row['sender_address'] === null ? null : String(row['sender_address']),
          status: String(row['status']) as OutreachRecipientStatus,
          sentAt: date(row['sent_at']),
          trialRedeemedAt: date(row['trial_redeemed_at']),
        })),
    );
  }

  /** Compare-and-set on the current status; false when it was no longer `from`. */
  async setStatus(
    id: string,
    from: OutreachCampaignStatus,
    to: OutreachCampaignStatus,
    at: Date,
    audit: PlatformAuditInput,
  ): Promise<boolean> {
    return this.database.identityTransaction(
      { correlationId: audit.correlationId, tables: [...TABLES, 'platform_admin_audit_events'] },
      async (tx) => {
        const result = await tx.query(OUTREACH_SQL.setStatus, [to, to, at, at, id, from]);
        if (affected(result) !== 1) return false;
        await insertPlatformAudit(tx, audit);
        return true;
      },
    );
  }

  /** Marks the recipient bounced and suppresses the address for every later mail. */
  async markBounced(id: string, at: Date, audit: PlatformAuditInput): Promise<boolean> {
    return this.database.identityTransaction(
      {
        correlationId: audit.correlationId,
        tables: [...TABLES, 'email_suppressions', 'platform_admin_audit_events'],
      },
      async (tx) => {
        const row = (await tx.query<Row[]>(OUTREACH_SQL.recipientHash, [id]))[0];
        if (row === undefined) return false;
        await tx.query(OUTREACH_SQL.markBounced, [at, id]);
        await tx.query(OUTREACH_SQL.suppress, [String(row['email_hash']), at, at, at]);
        await insertPlatformAudit(tx, audit);
        return true;
      },
    );
  }

  trialRecipient(id: string, correlationId: string): Promise<TrialRecipient | null> {
    return this.database.identityRead(
      { correlationId, tables: ['outreach_recipients'] },
      async (db) => {
        const row = (await db.query<Row[]>(OUTREACH_SQL.trialRecipient, [id]))[0];
        if (row === undefined) return null;
        return {
          id: String(row['id']),
          company: String(row['company']),
          emailEnc: String(row['email_enc']),
          language: String(row['language']),
          redeemed: row['trial_redeemed_at'] !== null && row['trial_redeemed_at'] !== undefined,
        };
      },
    );
  }
}

/** Inside the sign-up transaction: stamp the recipient once. False when already redeemed. */
export async function redeemTrialWithin(
  identity: IdentityQueryRunner,
  recipientId: string,
  userId: string,
  at: Date,
): Promise<boolean> {
  const result = await identity.query(OUTREACH_SQL.redeem, [at, userId, at, recipientId]);
  return affected(result) === 1;
}
