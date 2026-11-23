import type { RowDataPacket } from 'mysql2';
import { uuidv7 } from '@tmanage/domain';
import type { CampaignEmailKind, CampaignEmailText, CampaignLanguage } from '@tmanage/mail';
import { isCampaignLanguage } from '@tmanage/mail';
import type { IdentityQueryRunner, TenantDatabase } from '../../common/database/tenant-context.js';
import type {
  OutreachCampaignStatus,
  OutreachRecipientStatus,
} from '../../common/database/schema.js';
import type { PlatformAuditInput } from '../platform-admin/platform-admin.repository.js';
import { insertPlatformAudit } from '../platform-admin/platform-audit.service.js';
import type { OutreachSender } from './outreach-import.js';

/**
 * LANE-Q (0389) and OUTREACH MANAGER (0409) — every API statement on the outreach tables (IP-5:
 * one repository, the SQL in one place). All four tables are global platform tables, reached on
 * the identity path; every platform write carries its audit row in the same transaction. The
 * worker's statements live in `apps/worker/src/common/database/campaign-store.ts`.
 */

export type SenderPool = 'auto' | 'chosen';

export interface CampaignSettings {
  readonly languages: readonly CampaignLanguage[];
  readonly senderPool: SenderPool;
  readonly dailyCap: number;
  readonly warmup: boolean;
  readonly followupEnabled: boolean;
  readonly followupDays: number;
}

export interface CampaignRecord extends CampaignSettings {
  readonly id: string;
  readonly name: string;
  readonly status: OutreachCampaignStatus;
  readonly firstStartedAt: Date | null;
  readonly archivedAt: Date | null;
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
  readonly language: CampaignLanguage;
  readonly senderPersonId: string;
}

export interface RecipientSummary {
  readonly id: string;
  readonly campaignId: string;
  readonly company: string;
  readonly personName: string;
  readonly firstName: string;
  readonly country: string;
  readonly language: string;
  readonly senderPersonId: string;
  readonly senderAddress: string | null;
  readonly status: OutreachRecipientStatus;
  readonly sentAt: Date | null;
  readonly lastError: string | null;
  readonly trialRedeemedAt: Date | null;
  readonly walkthroughAt: Date | null;
  readonly repliedAt: Date | null;
  readonly followupStatus: string | null;
  readonly followupSentAt: Date | null;
  readonly optedOut: boolean;
  readonly createdAt: Date;
}

/** One recipient with the sealed address (edit, export, preview). */
export interface RecipientRecord extends RecipientSummary {
  readonly emailEnc: string;
  readonly emailHash: string;
  readonly timeZone: string;
}

/** What the trial-link door needs about one recipient. */
export interface TrialRecipient {
  readonly id: string;
  readonly company: string;
  readonly emailEnc: string;
  readonly language: string;
  readonly redeemed: boolean;
}

export interface EmailVersionRow {
  readonly kind: CampaignEmailKind;
  readonly version: number;
  readonly language: CampaignLanguage;
  readonly subject: string;
  readonly body: string;
  readonly createdBy: string | null;
  readonly createdAt: Date;
}

export interface EmailVersionSummary {
  readonly kind: CampaignEmailKind;
  readonly version: number;
  readonly languages: readonly CampaignLanguage[];
  readonly createdBy: string | null;
  readonly createdAt: Date;
}

export interface CampaignCounts {
  readonly byStatus: Readonly<Record<string, number>>;
  readonly redeemed: number;
  readonly walkthroughs: number;
  readonly followupsSent: number;
  readonly replied: number;
  readonly optedOut: number;
}

export interface KnownRecipient {
  readonly id: string;
  readonly hash: string;
  readonly company: string;
}

/** The campaigns the page lists, and the recipients one campaign page lists. */
export const MAX_LISTED_CAMPAIGNS = 100;
export const MAX_LISTED_RECIPIENTS = 5000;
export const MAX_LISTED_VERSIONS = 200;

const TABLES = ['outreach_campaigns', 'outreach_recipients'] as const;
const MANAGER_TABLES = [
  'outreach_campaigns',
  'outreach_recipients',
  'outreach_email_versions',
  'outreach_campaign_senders',
] as const;
const AUDIT = 'platform_admin_audit_events';

const CAMPAIGN_COLUMNS = `c.id AS id, c.name AS name, c.status AS status,
       c.languages AS languages, c.sender_pool AS sender_pool, c.daily_cap AS daily_cap,
       c.warmup AS warmup, c.followup_enabled AS followup_enabled,
       c.followup_days AS followup_days, c.archived_at AS archived_at,
       c.first_started_at AS first_started_at, c.created_at AS created_at`;

const RECIPIENT_COLUMNS = `r.id AS id, r.campaign_id AS campaign_id, r.company AS company,
       r.person_name AS person_name, r.first_name AS first_name, r.country AS country,
       r.language AS language, r.sender_person_id AS sender_person_id,
       p.address AS sender_address, r.status AS status, r.sent_at AS sent_at,
       r.last_error AS last_error, r.trial_redeemed_at AS trial_redeemed_at,
       r.walkthrough_at AS walkthrough_at, r.replied_at AS replied_at,
       r.followup_status AS followup_status, r.followup_sent_at AS followup_sent_at,
       r.created_at AS created_at,
       CASE WHEN EXISTS (SELECT 1 FROM email_suppressions s
                          WHERE s.address_hash = r.email_hash AND s.reason <> 'bounced')
            THEN 1 ELSE 0 END AS opted_out`;

export const OUTREACH_SQL = {
  senders: `SELECT p.id AS id, p.address AS address, p.name_en AS name_en, p.name_ar AS name_ar
     FROM platform_mail_people p WHERE p.active = 1 ORDER BY p.address ASC LIMIT 500`,
  known: `SELECT r.id AS id, r.email_hash AS email_hash, r.company AS company
     FROM outreach_recipients r LIMIT 100000`,
  suppressed: (count: number) => `SELECT s.address_hash AS address_hash FROM email_suppressions s
     WHERE s.address_hash IN (${Array.from({ length: count }, () => '?').join(', ')})`,
  insertCampaign: `INSERT INTO outreach_campaigns
     (id, name, status, languages, sender_pool, daily_cap, warmup, followup_enabled,
      followup_days, archived_at, first_started_at, created_by, created_at, updated_at)
     VALUES (?, ?, 'paused', ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?)`,
  insertRecipient: `INSERT INTO outreach_recipients
     (id, campaign_id, company, person_name, first_name, email_enc, email_hash, country,
      time_zone, language, sender_person_id, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?)`,
  insertVersion: `INSERT INTO outreach_email_versions
     (id, campaign_id, kind, version, language, subject, body, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  insertSender: `INSERT INTO outreach_campaign_senders (campaign_id, person_id, created_at)
     VALUES (?, ?, ?)`,
  deleteSenders: `DELETE FROM outreach_campaign_senders WHERE campaign_id = ?`,
  campaigns: `SELECT ${CAMPAIGN_COLUMNS}
     FROM outreach_campaigns c ORDER BY c.created_at DESC, c.id DESC LIMIT ${String(MAX_LISTED_CAMPAIGNS)}`,
  campaignById: `SELECT ${CAMPAIGN_COLUMNS} FROM outreach_campaigns c WHERE c.id = ? LIMIT 1`,
  lockCampaign: `SELECT c.id AS id FROM outreach_campaigns c WHERE c.id = ? FOR UPDATE`,
  chosenSenders: `SELECT s.person_id AS person_id FROM outreach_campaign_senders s
     WHERE s.campaign_id = ? ORDER BY s.person_id ASC LIMIT 500`,
  counts: `SELECT r.campaign_id AS campaign_id, r.status AS status, COUNT(*) AS n,
       SUM(CASE WHEN r.trial_redeemed_at IS NULL THEN 0 ELSE 1 END) AS redeemed,
       SUM(CASE WHEN r.walkthrough_at IS NULL THEN 0 ELSE 1 END) AS walkthroughs,
       SUM(CASE WHEN r.followup_status = 'sent' THEN 1 ELSE 0 END) AS followups,
       SUM(CASE WHEN r.replied_at IS NULL THEN 0 ELSE 1 END) AS replied,
       SUM(CASE WHEN EXISTS (SELECT 1 FROM email_suppressions s
                              WHERE s.address_hash = r.email_hash AND s.reason <> 'bounced')
                THEN 1 ELSE 0 END) AS opted_out
     FROM outreach_recipients r GROUP BY r.campaign_id, r.status`,
  recipients: `SELECT ${RECIPIENT_COLUMNS}
     FROM outreach_recipients r LEFT JOIN platform_mail_people p ON p.id = r.sender_person_id
     WHERE r.campaign_id = ? ORDER BY r.created_at ASC, r.id ASC LIMIT ${String(MAX_LISTED_RECIPIENTS)}`,
  recipientById: `SELECT ${RECIPIENT_COLUMNS}, r.email_enc AS email_enc, r.email_hash AS email_hash,
       r.time_zone AS time_zone
     FROM outreach_recipients r LEFT JOIN platform_mail_people p ON p.id = r.sender_person_id
     WHERE r.id = ? LIMIT 1`,
  exportRows: `SELECT ${RECIPIENT_COLUMNS}, r.email_enc AS email_enc, r.email_hash AS email_hash,
       r.time_zone AS time_zone
     FROM outreach_recipients r LEFT JOIN platform_mail_people p ON p.id = r.sender_person_id
     WHERE r.campaign_id = ? ORDER BY r.created_at ASC, r.id ASC LIMIT ${String(MAX_LISTED_RECIPIENTS)}`,
  setStatus: `UPDATE outreach_campaigns SET status = ?,
       first_started_at = CASE WHEN ? = 'running' AND first_started_at IS NULL THEN ? ELSE first_started_at END,
       updated_at = ?
     WHERE id = ? AND status = ? AND archived_at IS NULL`,
  updateSettings: `UPDATE outreach_campaigns SET name = ?, languages = ?, sender_pool = ?,
       daily_cap = ?, warmup = ?, followup_enabled = ?, followup_days = ?, updated_at = ?
     WHERE id = ?`,
  setArchived: `UPDATE outreach_campaigns SET archived_at = ?, updated_at = ?
     WHERE id = ? AND status <> 'running'`,
  reassign: `UPDATE outreach_recipients SET sender_person_id = ?, updated_at = ?
     WHERE id = ? AND status = 'queued'`,
  updateRecipient: `UPDATE outreach_recipients SET company = ?, person_name = ?, first_name = ?,
       email_enc = ?, email_hash = ?, country = ?, time_zone = ?, language = ?,
       sender_person_id = ?, updated_at = ?
     WHERE id = ? AND status = 'queued'`,
  deleteRecipient: `DELETE FROM outreach_recipients WHERE id = ? AND status = 'queued'`,
  markReplied: `UPDATE outreach_recipients SET replied_at = ?, updated_at = ?
     WHERE id = ? AND replied_at IS NULL`,
  recipientHash: `SELECT r.email_hash AS email_hash, r.status AS status FROM outreach_recipients r
     WHERE r.id = ? LIMIT 1`,
  markBounced: `UPDATE outreach_recipients SET status = 'bounced', updated_at = ? WHERE id = ?`,
  suppress: `INSERT INTO email_suppressions (address_hash, scope, reason, created_at, updated_at)
     VALUES (?, 'notifications', 'bounced', ?, ?)
     ON DUPLICATE KEY UPDATE reason = 'bounced', updated_at = ?`,
  latestVersions: `SELECT v.kind AS kind, v.version AS version, v.language AS language,
       v.subject AS subject, v.body AS body, v.created_by AS created_by, v.created_at AS created_at
     FROM outreach_email_versions v
     WHERE v.campaign_id = ?
       AND v.version = (SELECT MAX(v2.version) FROM outreach_email_versions v2
                         WHERE v2.campaign_id = v.campaign_id AND v2.kind = v.kind
                           AND v2.language = v.language)
     ORDER BY v.kind ASC, v.language ASC LIMIT 100`,
  versionList: `SELECT v.kind AS kind, v.version AS version,
       GROUP_CONCAT(v.language ORDER BY v.language SEPARATOR ',') AS languages,
       MAX(v.created_by) AS created_by, MAX(v.created_at) AS created_at
     FROM outreach_email_versions v WHERE v.campaign_id = ?
     GROUP BY v.kind, v.version ORDER BY v.version DESC, v.kind ASC
     LIMIT ${String(MAX_LISTED_VERSIONS)}`,
  version: `SELECT v.kind AS kind, v.version AS version, v.language AS language,
       v.subject AS subject, v.body AS body, v.created_by AS created_by, v.created_at AS created_at
     FROM outreach_email_versions v
     WHERE v.campaign_id = ? AND v.kind = ? AND v.version = ? ORDER BY v.language ASC LIMIT 20`,
  maxVersion: `SELECT COALESCE(MAX(v.version), 0) AS version FROM outreach_email_versions v
     WHERE v.campaign_id = ? AND v.kind = ?`,
  trialRecipient: `SELECT r.id AS id, r.company AS company, r.email_enc AS email_enc,
       r.language AS language, r.trial_redeemed_at AS trial_redeemed_at
     FROM outreach_recipients r WHERE r.id = ? LIMIT 1`,
  redeem: `UPDATE outreach_recipients SET trial_redeemed_at = ?, trial_user_id = ?, updated_at = ?
     WHERE id = ? AND trial_redeemed_at IS NULL`,
  stampWalkthrough: `UPDATE outreach_recipients SET walkthrough_at = ?, updated_at = ?
     WHERE id = ? AND walkthrough_at IS NULL`,
} as const;

type Row = RowDataPacket & Record<string, unknown>;

const date = (value: unknown): Date | null =>
  value === null || value === undefined ? null : new Date(value as string | Date);
const text = (value: unknown): string | null =>
  value === null || value === undefined ? null : String(value);

/** The stored comma list, kept to the languages the code knows (the first is the default). */
export function readLanguages(value: unknown): CampaignLanguage[] {
  const list = String(value ?? '')
    .split(',')
    .map((part) => part.trim())
    .filter(isCampaignLanguage);
  return list.length === 0 ? ['en'] : [...new Set(list)];
}

function toCampaign(row: Row): CampaignRecord {
  return {
    id: String(row['id']),
    name: String(row['name']),
    status: String(row['status']) as OutreachCampaignStatus,
    languages: readLanguages(row['languages']),
    senderPool: row['sender_pool'] === 'chosen' ? 'chosen' : 'auto',
    dailyCap: Number(row['daily_cap'] ?? 20),
    warmup: Number(row['warmup'] ?? 1) === 1,
    followupEnabled: Number(row['followup_enabled'] ?? 0) === 1,
    followupDays: Number(row['followup_days'] ?? 4),
    archivedAt: date(row['archived_at']),
    firstStartedAt: date(row['first_started_at']),
    createdAt: date(row['created_at']) ?? new Date(0),
  };
}

function toRecipient(row: Row): RecipientSummary {
  return {
    id: String(row['id']),
    campaignId: String(row['campaign_id']),
    company: String(row['company']),
    personName: String(row['person_name'] ?? ''),
    firstName: String(row['first_name']),
    country: String(row['country']),
    language: String(row['language']),
    senderPersonId: String(row['sender_person_id'] ?? ''),
    senderAddress: text(row['sender_address']),
    status: String(row['status']) as OutreachRecipientStatus,
    sentAt: date(row['sent_at']),
    lastError: text(row['last_error']),
    trialRedeemedAt: date(row['trial_redeemed_at']),
    walkthroughAt: date(row['walkthrough_at']),
    repliedAt: date(row['replied_at']),
    followupStatus: text(row['followup_status']),
    followupSentAt: date(row['followup_sent_at']),
    optedOut: Number(row['opted_out'] ?? 0) === 1,
    createdAt: date(row['created_at']) ?? new Date(0),
  };
}

function toRecipientRecord(row: Row): RecipientRecord {
  return {
    ...toRecipient(row),
    emailEnc: String(row['email_enc']),
    emailHash: String(row['email_hash']),
    timeZone: String(row['time_zone']),
  };
}

function toVersion(row: Row): EmailVersionRow {
  return {
    kind: row['kind'] === 'followup' ? 'followup' : 'intro',
    version: Number(row['version']),
    language: readLanguages(row['language'])[0] ?? 'en',
    subject: String(row['subject']),
    body: String(row['body']),
    createdBy: text(row['created_by']),
    createdAt: date(row['created_at']) ?? new Date(0),
  };
}

/** Rows a write touched (mysql2 answers a header, or `[header, fields]` through some paths). */
function affected(result: unknown): number {
  const header = Array.isArray(result) ? (result[0] as unknown) : result;
  const rows = (header as { affectedRows?: unknown } | null)?.affectedRows;
  return typeof rows === 'number' ? rows : 0;
}

export interface NewCampaign extends CampaignSettings {
  readonly id: string;
  readonly name: string;
  readonly createdBy: string;
  readonly at: Date;
  /** The chosen senders (only for `senderPool = 'chosen'`). */
  readonly senderIds: readonly string[];
  /** Version 1 of each e-mail, per language. */
  readonly versions: Readonly<
    Partial<
      Record<CampaignEmailKind, Readonly<Partial<Record<CampaignLanguage, CampaignEmailText>>>>
    >
  >;
}

export interface SettingsChange extends CampaignSettings {
  readonly name: string;
  /** Present when the chosen senders change: the new set. */
  readonly senderIds: readonly string[] | null;
  /** Queued recipients moved to another sender (a pool change). */
  readonly reassign: readonly { readonly id: string; readonly senderPersonId: string }[];
}

export interface RecipientChange {
  readonly id: string;
  readonly company: string;
  readonly personName: string;
  readonly firstName: string;
  readonly emailEnc: string;
  readonly emailHash: string;
  readonly country: string;
  readonly timeZone: string;
  readonly language: CampaignLanguage;
  readonly senderPersonId: string;
}

async function insertVersions(
  tx: IdentityQueryRunner,
  campaignId: string,
  kind: CampaignEmailKind,
  version: number,
  texts: Readonly<Partial<Record<CampaignLanguage, CampaignEmailText>>>,
  createdBy: string | null,
  at: Date,
): Promise<void> {
  for (const [language, mail] of Object.entries(texts)) {
    if (mail === undefined) continue;
    await tx.query(OUTREACH_SQL.insertVersion, [
      uuidv7(),
      campaignId,
      kind,
      version,
      language,
      mail.subject,
      mail.body,
      createdBy,
      at,
    ]);
  }
}

async function insertRecipientRows(
  tx: IdentityQueryRunner,
  recipients: readonly RecipientInsert[],
  at: Date,
): Promise<void> {
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
      at,
      at,
    ]);
  }
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
          nameEn: String(row['name_en'] ?? ''),
          nameAr: String(row['name_ar'] ?? ''),
        })),
    );
  }

  known(
    correlationId: string,
  ): Promise<{ hashes: Set<string>; companies: string[]; rows: KnownRecipient[] }> {
    return this.database.identityRead({ correlationId, tables: [...TABLES] }, async (db) => {
      const rows = (await db.query<Row[]>(OUTREACH_SQL.known)).map((row) => ({
        id: String(row['id']),
        hash: String(row['email_hash']),
        company: String(row['company']),
      }));
      return {
        hashes: new Set(rows.map((row) => row.hash)),
        companies: rows.map((row) => row.company),
        rows,
      };
    });
  }

  /** The hashes among `hashes` on the suppression list (unsubscribed or bounced). */
  suppressed(hashes: readonly string[], correlationId: string): Promise<Set<string>> {
    return this.database.identityRead(
      { correlationId, tables: ['email_suppressions'] },
      async (db) => {
        const found = new Set<string>();
        for (let i = 0; i < hashes.length; i += 500) {
          const chunk = hashes.slice(i, i + 500);
          if (chunk.length === 0) continue;
          for (const row of await db.query<Row[]>(OUTREACH_SQL.suppressed(chunk.length), chunk)) {
            found.add(String(row['address_hash']));
          }
        }
        return found;
      },
    );
  }

  /** The campaign, its chosen senders, version 1 of its e-mails, its recipients and the audit. */
  async insertCampaign(
    campaign: NewCampaign,
    recipients: readonly RecipientInsert[],
    audit: PlatformAuditInput,
  ): Promise<void> {
    await this.database.identityTransaction(
      { correlationId: audit.correlationId, tables: [...MANAGER_TABLES, AUDIT] },
      async (tx) => {
        await tx.query(OUTREACH_SQL.insertCampaign, [
          campaign.id,
          campaign.name,
          campaign.languages.join(','),
          campaign.senderPool,
          campaign.dailyCap,
          campaign.warmup ? 1 : 0,
          campaign.followupEnabled ? 1 : 0,
          campaign.followupDays,
          campaign.createdBy,
          campaign.at,
          campaign.at,
        ]);
        for (const personId of campaign.senderIds) {
          await tx.query(OUTREACH_SQL.insertSender, [campaign.id, personId, campaign.at]);
        }
        for (const [kind, texts] of Object.entries(campaign.versions)) {
          if (texts === undefined) continue;
          await insertVersions(
            tx,
            campaign.id,
            kind as CampaignEmailKind,
            1,
            texts,
            campaign.createdBy,
            campaign.at,
          );
        }
        await insertRecipientRows(tx, recipients, campaign.at);
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

  chosenSenders(campaignId: string, correlationId: string): Promise<readonly string[]> {
    return this.database.identityRead(
      { correlationId, tables: ['outreach_campaign_senders'] },
      async (db) =>
        (await db.query<Row[]>(OUTREACH_SQL.chosenSenders, [campaignId])).map((row) =>
          String(row['person_id']),
        ),
    );
  }

  counts(correlationId: string): Promise<ReadonlyMap<string, CampaignCounts>> {
    return this.database.identityRead(
      { correlationId, tables: [...TABLES, 'email_suppressions'] },
      async (db) => {
        const map = new Map<
          string,
          {
            byStatus: Record<string, number>;
            redeemed: number;
            walkthroughs: number;
            followupsSent: number;
            replied: number;
            optedOut: number;
          }
        >();
        for (const row of await db.query<Row[]>(OUTREACH_SQL.counts)) {
          const id = String(row['campaign_id']);
          const entry = map.get(id) ?? {
            byStatus: {},
            redeemed: 0,
            walkthroughs: 0,
            followupsSent: 0,
            replied: 0,
            optedOut: 0,
          };
          entry.byStatus[String(row['status'])] = Number(row['n']);
          entry.redeemed += Number(row['redeemed'] ?? 0);
          entry.walkthroughs += Number(row['walkthroughs'] ?? 0);
          entry.followupsSent += Number(row['followups'] ?? 0);
          entry.replied += Number(row['replied'] ?? 0);
          entry.optedOut += Number(row['opted_out'] ?? 0);
          map.set(id, entry);
        }
        return map;
      },
    );
  }

  recipients(campaignId: string, correlationId: string): Promise<readonly RecipientSummary[]> {
    return this.database.identityRead(
      { correlationId, tables: [...TABLES, 'platform_mail_people', 'email_suppressions'] },
      async (db) => (await db.query<Row[]>(OUTREACH_SQL.recipients, [campaignId])).map(toRecipient),
    );
  }

  recipient(id: string, correlationId: string): Promise<RecipientRecord | null> {
    return this.database.identityRead(
      { correlationId, tables: [...TABLES, 'platform_mail_people', 'email_suppressions'] },
      async (db) => {
        const row = (await db.query<Row[]>(OUTREACH_SQL.recipientById, [id]))[0];
        return row === undefined ? null : toRecipientRecord(row);
      },
    );
  }

  /** The rows of an export, with the sealed addresses; the export itself is audited. */
  async exportRows(
    campaignId: string,
    audit: PlatformAuditInput,
  ): Promise<readonly RecipientRecord[]> {
    return this.database.identityTransaction(
      {
        correlationId: audit.correlationId,
        tables: [...TABLES, 'platform_mail_people', 'email_suppressions', AUDIT],
      },
      async (tx) => {
        const rows = (await tx.query<Row[]>(OUTREACH_SQL.exportRows, [campaignId])).map(
          toRecipientRecord,
        );
        await insertPlatformAudit(tx, audit);
        return rows;
      },
    );
  }

  /** Compare-and-set on the current status; false when it was no longer `from` (or archived). */
  async setStatus(
    id: string,
    from: OutreachCampaignStatus,
    to: OutreachCampaignStatus,
    at: Date,
    audit: PlatformAuditInput,
  ): Promise<boolean> {
    return this.database.identityTransaction(
      { correlationId: audit.correlationId, tables: [...TABLES, AUDIT] },
      async (tx) => {
        const result = await tx.query(OUTREACH_SQL.setStatus, [to, to, at, at, id, from]);
        if (affected(result) !== 1) return false;
        await insertPlatformAudit(tx, audit);
        return true;
      },
    );
  }

  /** Name, languages, senders, pace and follow-up; the chosen senders are replaced as a set. */
  async updateSettings(
    id: string,
    change: SettingsChange,
    at: Date,
    audit: PlatformAuditInput,
  ): Promise<boolean> {
    return this.database.identityTransaction(
      { correlationId: audit.correlationId, tables: [...MANAGER_TABLES, AUDIT] },
      async (tx) => {
        const result = await tx.query(OUTREACH_SQL.updateSettings, [
          change.name,
          change.languages.join(','),
          change.senderPool,
          change.dailyCap,
          change.warmup ? 1 : 0,
          change.followupEnabled ? 1 : 0,
          change.followupDays,
          at,
          id,
        ]);
        if (affected(result) !== 1) return false;
        if (change.senderIds !== null) {
          await tx.query(OUTREACH_SQL.deleteSenders, [id]);
          for (const personId of change.senderIds) {
            await tx.query(OUTREACH_SQL.insertSender, [id, personId, at]);
          }
        }
        for (const move of change.reassign) {
          await tx.query(OUTREACH_SQL.reassign, [move.senderPersonId, at, move.id]);
        }
        await insertPlatformAudit(tx, audit);
        return true;
      },
    );
  }

  /** Archive (`at`) or bring back (`null`); a running campaign is paused or stopped first. */
  async setArchived(
    id: string,
    archivedAt: Date | null,
    at: Date,
    audit: PlatformAuditInput,
  ): Promise<boolean> {
    return this.database.identityTransaction(
      { correlationId: audit.correlationId, tables: [...TABLES, AUDIT] },
      async (tx) => {
        const result = await tx.query(OUTREACH_SQL.setArchived, [archivedAt, at, id]);
        if (affected(result) !== 1) return false;
        await insertPlatformAudit(tx, audit);
        return true;
      },
    );
  }

  latestVersions(campaignId: string, correlationId: string): Promise<readonly EmailVersionRow[]> {
    return this.database.identityRead(
      { correlationId, tables: ['outreach_email_versions'] },
      async (db) =>
        (await db.query<Row[]>(OUTREACH_SQL.latestVersions, [campaignId])).map(toVersion),
    );
  }

  versionList(campaignId: string, correlationId: string): Promise<readonly EmailVersionSummary[]> {
    return this.database.identityRead(
      { correlationId, tables: ['outreach_email_versions'] },
      async (db) =>
        (await db.query<Row[]>(OUTREACH_SQL.versionList, [campaignId])).map((row) => ({
          kind: row['kind'] === 'followup' ? 'followup' : 'intro',
          version: Number(row['version']),
          languages: readLanguages(row['languages']),
          createdBy: text(row['created_by']),
          createdAt: date(row['created_at']) ?? new Date(0),
        })),
    );
  }

  version(
    campaignId: string,
    kind: CampaignEmailKind,
    version: number,
    correlationId: string,
  ): Promise<readonly EmailVersionRow[]> {
    return this.database.identityRead(
      { correlationId, tables: ['outreach_email_versions'] },
      async (db) =>
        (await db.query<Row[]>(OUTREACH_SQL.version, [campaignId, kind, version])).map(toVersion),
    );
  }

  /**
   * A save: the next version number for this e-mail, one row per language, and the audit row.
   * The campaign row is locked first, so two saves at once get two numbers, never the same one.
   */
  async saveVersion(
    campaignId: string,
    kind: CampaignEmailKind,
    texts: Readonly<Partial<Record<CampaignLanguage, CampaignEmailText>>>,
    createdBy: string,
    at: Date,
    audit: (version: number) => PlatformAuditInput,
  ): Promise<number | null> {
    return this.database.identityTransaction(
      { correlationId: audit(0).correlationId, tables: [...MANAGER_TABLES, AUDIT] },
      async (tx) => {
        const locked = await tx.query<Row[]>(OUTREACH_SQL.lockCampaign, [campaignId]);
        if (locked.length === 0) return null;
        const current = (await tx.query<Row[]>(OUTREACH_SQL.maxVersion, [campaignId, kind]))[0];
        const version = Number(current?.['version'] ?? 0) + 1;
        await insertVersions(tx, campaignId, kind, version, texts, createdBy, at);
        await insertPlatformAudit(tx, audit(version));
        return version;
      },
    );
  }

  /** New recipients into an existing campaign (add one, or import more). */
  async insertRecipients(
    recipients: readonly RecipientInsert[],
    at: Date,
    audit: PlatformAuditInput,
  ): Promise<void> {
    await this.database.identityTransaction(
      { correlationId: audit.correlationId, tables: [...TABLES, AUDIT] },
      async (tx) => {
        await insertRecipientRows(tx, recipients, at);
        await insertPlatformAudit(tx, audit);
      },
    );
  }

  /** Changes a queued recipient; false when it was no longer queued. */
  async updateRecipient(
    change: RecipientChange,
    at: Date,
    audit: PlatformAuditInput,
  ): Promise<boolean> {
    return this.database.identityTransaction(
      { correlationId: audit.correlationId, tables: [...TABLES, AUDIT] },
      async (tx) => {
        const result = await tx.query(OUTREACH_SQL.updateRecipient, [
          change.company,
          change.personName,
          change.firstName,
          change.emailEnc,
          change.emailHash,
          change.country,
          change.timeZone,
          change.language,
          change.senderPersonId,
          at,
          change.id,
        ]);
        if (affected(result) !== 1) return false;
        await insertPlatformAudit(tx, audit);
        return true;
      },
    );
  }

  /** Removes a queued recipient (the sealed address goes with the row). */
  async deleteRecipient(id: string, audit: PlatformAuditInput): Promise<boolean> {
    return this.database.identityTransaction(
      { correlationId: audit.correlationId, tables: [...TABLES, AUDIT] },
      async (tx) => {
        const result = await tx.query(OUTREACH_SQL.deleteRecipient, [id]);
        if (affected(result) !== 1) return false;
        await insertPlatformAudit(tx, audit);
        return true;
      },
    );
  }

  /** "They replied": stops the follow-up. False when already marked. */
  async markReplied(id: string, at: Date, audit: PlatformAuditInput): Promise<boolean> {
    return this.database.identityTransaction(
      { correlationId: audit.correlationId, tables: [...TABLES, AUDIT] },
      async (tx) => {
        const result = await tx.query(OUTREACH_SQL.markReplied, [at, at, id]);
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
        tables: [...TABLES, 'email_suppressions', AUDIT],
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

  /** An audit row on its own (the test send, which writes nothing else). */
  async audit(audit: PlatformAuditInput): Promise<void> {
    await this.database.identityTransaction(
      { correlationId: audit.correlationId, tables: [AUDIT] },
      (tx) => insertPlatformAudit(tx, audit),
    );
  }

  /** "Book a walkthrough" from a campaign mail: stamp the recipient once. */
  stampWalkthrough(id: string, at: Date, correlationId: string): Promise<boolean> {
    return this.database.identityTransaction(
      { correlationId, tables: ['outreach_recipients'] },
      async (tx) => affected(await tx.query(OUTREACH_SQL.stampWalkthrough, [at, at, id])) === 1,
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
