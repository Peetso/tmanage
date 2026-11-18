import type { RowDataPacket } from 'mysql2';
import type { TenantDatabase } from '../../../common/database/tenant-context.js';
import type { PlatformAuditInput } from '../platform-admin.repository.js';
import { insertPlatformAudit } from '../platform-audit.service.js';

/**
 * EMAILBUILD2 (0373) — every statement of the "Feature news" card and the "Tips and reminders"
 * switch. Both are global platform tables, reached on the identity path; every write carries its
 * platform audit row in the same transaction. No DELETE: a note is written once and sent once.
 */

export const TIPS_SWITCH_KEY = 'mail.tips_enabled';
/** The card lists the newest notes only. */
export const MAX_NEWS_LISTED = 50;

export interface FeatureNewsRecord {
  readonly id: string;
  readonly titleEn: string;
  readonly titleAr: string;
  readonly bodyEn: string;
  readonly bodyAr: string;
  readonly link: string;
  readonly createdAt: Date;
  readonly sentAt: Date | null;
}

export type FeatureNewsInput = Pick<
  FeatureNewsRecord,
  'titleEn' | 'titleAr' | 'bodyEn' | 'bodyAr' | 'link'
>;

const COLUMNS = `n.id AS id, n.title_en AS title_en, n.title_ar AS title_ar, n.body_en AS body_en,
  n.body_ar AS body_ar, n.link AS link, n.created_at AS created_at, n.sent_at AS sent_at`;

export const PERSON_MAIL_SQL = {
  switch: `SELECT ps.setting_value AS value FROM platform_settings ps WHERE ps.setting_key = ? LIMIT 1`,
  writeSwitch: `INSERT INTO platform_settings (setting_key, setting_value, updated_by_user_id, updated_at)
    VALUES (?, ?, ?, current_timestamp(3))
    ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value),
      updated_by_user_id = VALUES(updated_by_user_id), updated_at = current_timestamp(3)`,
  list: `SELECT ${COLUMNS} FROM platform_feature_news n
    ORDER BY n.created_at DESC, n.id DESC LIMIT ${String(MAX_NEWS_LISTED)}`,
  byId: `SELECT ${COLUMNS} FROM platform_feature_news n WHERE n.id = ? LIMIT 1`,
  insert: `INSERT INTO platform_feature_news
    (id, title_en, title_ar, body_en, body_ar, link, created_by_user_id, created_at, sent_at,
     sent_by_user_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, current_timestamp(3), NULL, NULL)`,
  /** Once only: a note already sent is never sent again (affectedRows 0). */
  send: `UPDATE platform_feature_news SET sent_at = current_timestamp(3), sent_by_user_id = ?
    WHERE id = ? AND sent_at IS NULL`,
} as const;

type Row = RowDataPacket & Record<string, unknown>;

function affected(value: unknown): number {
  return typeof value === 'object' &&
    value !== null &&
    'affectedRows' in value &&
    typeof value.affectedRows === 'number'
    ? value.affectedRows
    : 0;
}

const toDate = (value: unknown): Date => (value instanceof Date ? value : new Date(String(value)));

function toRecord(row: Row): FeatureNewsRecord {
  return {
    id: String(row['id']),
    titleEn: String(row['title_en']),
    titleAr: String(row['title_ar']),
    bodyEn: String(row['body_en']),
    bodyAr: String(row['body_ar']),
    link: String(row['link']),
    createdAt: toDate(row['created_at']),
    sentAt: row['sent_at'] === null || row['sent_at'] === undefined ? null : toDate(row['sent_at']),
  };
}

const READ_TABLES = ['platform_settings', 'platform_feature_news'] as const;
const SWITCH_TABLES = ['platform_settings', 'platform_admin_audit_events'] as const;
const NEWS_TABLES = ['platform_feature_news', 'platform_admin_audit_events'] as const;

export class PersonMailRepository {
  constructor(private readonly database: TenantDatabase) {}

  /** The switch (absent = off) and the newest notes. */
  state(
    correlationId: string,
  ): Promise<{ tipsEnabled: boolean; news: readonly FeatureNewsRecord[] }> {
    return this.database.identityRead({ correlationId, tables: [...READ_TABLES] }, async (db) => {
      const value = (await db.query<Row[]>(PERSON_MAIL_SQL.switch, [TIPS_SWITCH_KEY]))[0]?.[
        'value'
      ];
      const news = (await db.query<Row[]>(PERSON_MAIL_SQL.list)).map(toRecord);
      return { tipsEnabled: value === 'on', news };
    });
  }

  byId(id: string, correlationId: string): Promise<FeatureNewsRecord | null> {
    return this.database.identityRead(
      { correlationId, tables: ['platform_feature_news'] },
      async (db) => {
        const row = (await db.query<Row[]>(PERSON_MAIL_SQL.byId, [id]))[0];
        return row === undefined ? null : toRecord(row);
      },
    );
  }

  async writeSwitch(enabled: boolean, audit: PlatformAuditInput): Promise<void> {
    await this.database.identityTransaction(
      { correlationId: audit.correlationId, tables: [...SWITCH_TABLES] },
      async (tx) => {
        await tx.query(PERSON_MAIL_SQL.writeSwitch, [
          TIPS_SWITCH_KEY,
          enabled ? 'on' : 'off',
          audit.actorUserId,
        ]);
        await insertPlatformAudit(tx, audit);
      },
    );
  }

  async insert(
    id: string,
    input: FeatureNewsInput,
    createdBy: string,
    audit: PlatformAuditInput,
  ): Promise<void> {
    await this.database.identityTransaction(
      { correlationId: audit.correlationId, tables: [...NEWS_TABLES] },
      async (tx) => {
        await tx.query(PERSON_MAIL_SQL.insert, [
          id,
          input.titleEn,
          input.titleAr,
          input.bodyEn,
          input.bodyAr,
          input.link,
          createdBy,
        ]);
        await insertPlatformAudit(tx, audit);
      },
    );
  }

  /** True when this call sent the note; false when it was already sent. */
  async send(id: string, sentBy: string, audit: PlatformAuditInput): Promise<boolean> {
    return this.database.identityTransaction(
      { correlationId: audit.correlationId, tables: [...NEWS_TABLES] },
      async (tx) => {
        const result: unknown = await tx.query(PERSON_MAIL_SQL.send, [sentBy, id]);
        if (affected(result) !== 1) return false;
        await insertPlatformAudit(tx, audit);
        return true;
      },
    );
  }
}
