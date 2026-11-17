import type { MailLanguage, MailPerson, MailPersonRef, SenderDirectory } from '@tmanage/mail';
import type { RowDataPacket } from 'mysql2';
import type {
  MailPersonLanguages,
  MailPersonRegion,
  MailPersonTopic,
} from '../../../common/database/schema.js';
import type { TenantDatabase } from '../../../common/database/tenant-context.js';
import type { PlatformAuditInput } from '../platform-admin.repository.js';
import { insertPlatformAudit } from '../platform-audit.service.js';

/**
 * EMAILBUILD (0371) — every statement of the "E-mail people" card. `platform_mail_people` is a
 * global platform table, reached on the identity path; every write carries its platform audit row
 * in the same transaction. No DELETE: a person is switched off, never removed.
 */

export interface MailPersonRecord {
  readonly id: string;
  readonly nameEn: string;
  readonly nameAr: string;
  readonly roleEn: string;
  readonly roleAr: string;
  readonly address: string;
  readonly languages: MailPersonLanguages;
  readonly region: MailPersonRegion;
  readonly topic: MailPersonTopic;
  readonly active: boolean;
}

export type MailPersonInput = Omit<MailPersonRecord, 'id'>;

const READ_TABLES = ['platform_mail_people'] as const;
const WRITE_TABLES = ['platform_mail_people', 'platform_admin_audit_events'] as const;
/** The registry is small by design (30 seeded, imports of at most 100). */
export const MAX_MAIL_PEOPLE = 500;

const COLUMNS = `p.id AS id, p.name_en AS name_en, p.name_ar AS name_ar, p.role_en AS role_en,
  p.role_ar AS role_ar, p.address AS address, p.languages AS languages, p.region AS region,
  p.topic AS topic, p.active AS active`;

export const MAIL_PEOPLE_SQL = {
  list: `SELECT ${COLUMNS} FROM platform_mail_people p
    ORDER BY p.region ASC, p.topic ASC, p.name_en ASC LIMIT ${MAX_MAIL_PEOPLE}`,
  byId: `SELECT ${COLUMNS} FROM platform_mail_people p WHERE p.id = ? LIMIT 1`,
  byAddress: `SELECT p.id AS id FROM platform_mail_people p WHERE p.address = ? LIMIT 1`,
  insert: `INSERT INTO platform_mail_people
    (id, name_en, name_ar, role_en, role_ar, address, languages, region, topic, active,
     created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, current_timestamp(3), current_timestamp(3))`,
  update: `UPDATE platform_mail_people SET name_en = ?, name_ar = ?, role_en = ?, role_ar = ?,
    address = ?, languages = ?, region = ?, topic = ?, active = ?, updated_at = current_timestamp(3)
    WHERE id = ?`,
} as const;

type Row = RowDataPacket & Record<string, unknown>;

function toRecord(row: Row): MailPersonRecord {
  return {
    id: String(row['id']),
    nameEn: String(row['name_en']),
    nameAr: String(row['name_ar']),
    roleEn: String(row['role_en']),
    roleAr: String(row['role_ar']),
    address: String(row['address']),
    languages: String(row['languages']) as MailPersonLanguages,
    region: String(row['region']) as MailPersonRegion,
    topic: String(row['topic']) as MailPersonTopic,
    active: row['active'] === true || Number(row['active']) === 1,
  };
}

function values(input: MailPersonInput): (string | number)[] {
  return [
    input.nameEn,
    input.nameAr,
    input.roleEn,
    input.roleAr,
    input.address,
    input.languages,
    input.region,
    input.topic,
    input.active ? 1 : 0,
  ];
}

export class MailPeopleRepository {
  constructor(private readonly database: TenantDatabase) {}

  list(correlationId: string): Promise<readonly MailPersonRecord[]> {
    return this.database.identityRead({ correlationId, tables: [...READ_TABLES] }, async (db) =>
      (await db.query<Row[]>(MAIL_PEOPLE_SQL.list)).map(toRecord),
    );
  }

  byId(id: string, correlationId: string): Promise<MailPersonRecord | null> {
    return this.database.identityRead({ correlationId, tables: [...READ_TABLES] }, async (db) => {
      const row = (await db.query<Row[]>(MAIL_PEOPLE_SQL.byId, [id]))[0];
      return row === undefined ? null : toRecord(row);
    });
  }

  /** The ids already holding any of these addresses. */
  taken(addresses: readonly string[], correlationId: string): Promise<readonly string[]> {
    return this.database.identityRead({ correlationId, tables: [...READ_TABLES] }, async (db) => {
      const found: string[] = [];
      for (const address of addresses) {
        const row = (await db.query<Row[]>(MAIL_PEOPLE_SQL.byAddress, [address]))[0];
        if (row !== undefined) found.push(address);
      }
      return found;
    });
  }

  /** New rows (one, or a whole import) and their one audit row, together. */
  async insert(rows: readonly MailPersonRecord[], audit: PlatformAuditInput): Promise<void> {
    await this.database.identityTransaction(
      { correlationId: audit.correlationId, tables: [...WRITE_TABLES] },
      async (tx) => {
        for (const row of rows) await tx.query(MAIL_PEOPLE_SQL.insert, [row.id, ...values(row)]);
        await insertPlatformAudit(tx, audit);
      },
    );
  }

  async update(row: MailPersonRecord, audit: PlatformAuditInput): Promise<void> {
    await this.database.identityTransaction(
      { correlationId: audit.correlationId, tables: [...WRITE_TABLES] },
      async (tx) => {
        await tx.query(MAIL_PEOPLE_SQL.update, [...values(row), row.id]);
        await insertPlatformAudit(tx, audit);
      },
    );
  }

  /** An audit row alone (a test send changes no person). */
  async audit(audit: PlatformAuditInput): Promise<void> {
    await this.database.identityTransaction(
      { correlationId: audit.correlationId, tables: ['platform_admin_audit_events'] },
      (tx) => insertPlatformAudit(tx, audit),
    );
  }
}

/**
 * The API's sender directory: it answers only a platform admin's test send (one named row, active
 * or not, so a person can be checked before being switched on). Tips are the worker's.
 */
export function mailPeopleTestDirectory(database: TenantDatabase): SenderDirectory {
  const repository = new MailPeopleRepository(database);
  return {
    async personFor(
      _organizationId: string | undefined,
      ref: MailPersonRef,
      language: MailLanguage,
    ): Promise<MailPerson | null> {
      if (ref.kind !== 'test') return null;
      const row = await repository.byId(ref.personId, 'mail-people-test-send');
      if (row === null) return null;
      return language === 'ar'
        ? { name: row.nameAr, role: row.roleAr, address: row.address }
        : { name: row.nameEn, role: row.roleEn, address: row.address };
    },
  };
}
