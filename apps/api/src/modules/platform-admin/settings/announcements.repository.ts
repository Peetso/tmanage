import { uuidv7 } from '@tmanage/domain';
import type { RowDataPacket } from 'mysql2';
import type { SqlParameter, TenantDatabase } from '../../../common/database/tenant-context.js';
import type { PlatformAuditInput } from '../platform-admin.repository.js';
import { insertPlatformAudit } from '../platform-audit.service.js';
import { parseIdList } from './flags.repository.js';

/**
 * The platform banner (0244 `platform_announcements`) — global, identity path. No DELETE: the
 * operator's Delete unpublishes the row and sets `archived`, which hides it from every list.
 */

export const ANNOUNCEMENT_SEVERITIES = ['info', 'warning', 'critical'] as const;
export type AnnouncementSeverity = (typeof ANNOUNCEMENT_SEVERITIES)[number];
export const ANNOUNCEMENT_AUDIENCES = ['everyone', 'organizations', 'clients'] as const;
export type AnnouncementAudience = (typeof ANNOUNCEMENT_AUDIENCES)[number];

/** The most announcements the D3 list shows, and the most live ones the public read folds. */
export const MAX_ANNOUNCEMENTS = 200;
export const MAX_LIVE_ANNOUNCEMENTS = 20;

/** Why the public banner read resolves an organization slug (bootstrap read reason). */
export const ANNOUNCEMENT_AUDIENCE_REASON =
  'platform announcement banner: resolve the reader organization for a chosen-organizations audience';

const WRITE_TABLES = ['platform_announcements', 'platform_admin_audit_events'] as const;

const COLUMNS = `a.id as id, a.title_en as title_en, a.title_ar as title_ar, a.body_en as body_en,
  a.body_ar as body_ar, a.severity as severity, a.link_url as link_url, a.audience as audience,
  a.audience_org_ids_json as audience_org_ids, a.dismissible as dismissible,
  a.starts_at as starts_at, a.ends_at as ends_at, a.published as published,
  a.archived as archived, a.created_at as created_at, a.updated_at as updated_at`;

export const ANNOUNCEMENTS_SQL = {
  list: `select ${COLUMNS} from platform_announcements a where a.archived = 0
    order by a.created_at desc limit ${MAX_ANNOUNCEMENTS}`,
  byId: `select ${COLUMNS} from platform_announcements a where a.id = ? limit 1`,
  organizationBySlug: `select o.id as id from organizations o where o.slug = ? limit 1`,
  live: `select ${COLUMNS} from platform_announcements a
    where a.published = 1 and a.archived = 0
      and (a.starts_at is null or a.starts_at <= ?) and (a.ends_at is null or a.ends_at > ?)
    order by a.updated_at desc limit ${MAX_LIVE_ANNOUNCEMENTS}`,
  insert: `insert into platform_announcements
      (id, title_en, title_ar, body_en, body_ar, severity, link_url, audience,
       audience_org_ids_json, dismissible, starts_at, ends_at, published, archived, created_by,
       created_at, updated_at)
    values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, current_timestamp(3), current_timestamp(3))`,
  update: `update platform_announcements set title_en = ?, title_ar = ?, body_en = ?, body_ar = ?,
      severity = ?, link_url = ?, audience = ?, audience_org_ids_json = ?, dismissible = ?,
      starts_at = ?, ends_at = ?, updated_at = current_timestamp(3)
    where id = ? and archived = 0`,
  publish: `update platform_announcements set published = ?, updated_at = current_timestamp(3)
    where id = ? and archived = 0`,
  archive: `update platform_announcements set published = 0, archived = 1,
      updated_at = current_timestamp(3)
    where id = ? and archived = 0`,
} as const;

type Row = RowDataPacket & Record<string, unknown>;

export interface AnnouncementRecord {
  readonly id: string;
  readonly titleEn: string;
  readonly titleAr: string | null;
  readonly bodyEn: string;
  readonly bodyAr: string | null;
  readonly severity: AnnouncementSeverity;
  readonly linkUrl: string | null;
  readonly audience: AnnouncementAudience;
  readonly audienceOrganizationIds: readonly string[];
  readonly dismissible: boolean;
  readonly startsAt: Date | null;
  readonly endsAt: Date | null;
  readonly published: boolean;
  readonly archived: boolean;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** The editable fields of one announcement. */
export type AnnouncementInput = Omit<
  AnnouncementRecord,
  'id' | 'published' | 'archived' | 'createdAt' | 'updatedAt'
>;

function bool(value: unknown): boolean {
  return value === true || value === 1 || value === '1';
}

function date(value: unknown): Date | null {
  if (value === null || value === undefined) return null;
  const parsed = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function text(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

function toRecord(row: Row): AnnouncementRecord {
  const severity = String(row['severity']);
  const audience = String(row['audience']);
  return {
    id: String(row['id']),
    titleEn: String(row['title_en'] ?? ''),
    titleAr: text(row['title_ar']),
    bodyEn: String(row['body_en'] ?? ''),
    bodyAr: text(row['body_ar']),
    severity: (ANNOUNCEMENT_SEVERITIES as readonly string[]).includes(severity)
      ? (severity as AnnouncementSeverity)
      : 'info',
    linkUrl: text(row['link_url']),
    audience: (ANNOUNCEMENT_AUDIENCES as readonly string[]).includes(audience)
      ? (audience as AnnouncementAudience)
      : 'everyone',
    audienceOrganizationIds: parseIdList(row['audience_org_ids']),
    dismissible: bool(row['dismissible']),
    startsAt: date(row['starts_at']),
    endsAt: date(row['ends_at']),
    published: bool(row['published']),
    archived: bool(row['archived']),
    createdAt: date(row['created_at']) ?? new Date(0),
    updatedAt: date(row['updated_at']) ?? new Date(0),
  };
}

function values(input: AnnouncementInput): SqlParameter[] {
  return [
    input.titleEn,
    input.titleAr,
    input.bodyEn,
    input.bodyAr,
    input.severity,
    input.linkUrl,
    input.audience,
    input.audienceOrganizationIds.length > 0 ? JSON.stringify(input.audienceOrganizationIds) : null,
    input.dismissible ? 1 : 0,
    input.startsAt,
    input.endsAt,
  ];
}

export class PlatformAnnouncementsRepository {
  constructor(private readonly database: TenantDatabase) {}

  async list(correlationId: string): Promise<readonly AnnouncementRecord[]> {
    return this.database.identityRead(
      { correlationId, tables: ['platform_announcements'] },
      async (db) => (await db.query<Row[]>(ANNOUNCEMENTS_SQL.list)).map(toRecord),
    );
  }

  async find(id: string, correlationId: string): Promise<AnnouncementRecord | null> {
    return this.database.identityRead(
      { correlationId, tables: ['platform_announcements'] },
      async (db) => {
        const [row] = await db.query<Row[]>(ANNOUNCEMENTS_SQL.byId, [id]);
        return row ? toRecord(row) : null;
      },
    );
  }

  /** Published, not archived, inside their window at `now`. */
  async live(now: Date, correlationId: string): Promise<readonly AnnouncementRecord[]> {
    return this.database.identityRead(
      { correlationId, tables: ['platform_announcements'] },
      async (db) => (await db.query<Row[]>(ANNOUNCEMENTS_SQL.live, [now, now])).map(toRecord),
    );
  }

  /**
   * The organization a banner reader is in, from the slug in its URL, so a "chosen organizations"
   * banner reaches only them. Bootstrap read of one id; the slug is not secret (it is in the URL).
   */
  async organizationIdForSlug(slug: string, correlationId: string): Promise<string | null> {
    return this.database.bootstrapRead(
      { correlationId, reason: ANNOUNCEMENT_AUDIENCE_REASON, tables: ['organizations'] },
      async (db) => {
        const [row] = await db.query<Row[]>(ANNOUNCEMENTS_SQL.organizationBySlug, [slug]);
        return row ? String(row['id']) : null;
      },
    );
  }

  async create(
    input: AnnouncementInput,
    published: boolean,
    createdBy: string,
    audit: (id: string) => PlatformAuditInput,
  ): Promise<string> {
    const id = uuidv7();
    const row = audit(id);
    await this.database.identityTransaction(
      { correlationId: row.correlationId, tables: [...WRITE_TABLES] },
      async (tx) => {
        await tx.query(ANNOUNCEMENTS_SQL.insert, [
          id,
          ...values(input),
          published ? 1 : 0,
          createdBy,
        ]);
        await insertPlatformAudit(tx, row);
      },
    );
    return id;
  }

  /** `false` when there is no such (non-archived) announcement; nothing is written then. */
  async update(id: string, input: AnnouncementInput, audit: PlatformAuditInput): Promise<boolean> {
    return this.write(id, ANNOUNCEMENTS_SQL.update, [...values(input), id], audit);
  }

  async setPublished(id: string, published: boolean, audit: PlatformAuditInput): Promise<boolean> {
    return this.write(id, ANNOUNCEMENTS_SQL.publish, [published ? 1 : 0, id], audit);
  }

  async archive(id: string, audit: PlatformAuditInput): Promise<boolean> {
    return this.write(id, ANNOUNCEMENTS_SQL.archive, [id], audit);
  }

  private async write(
    id: string,
    statement: string,
    params: SqlParameter[],
    audit: PlatformAuditInput,
  ): Promise<boolean> {
    return this.database.identityTransaction(
      { correlationId: audit.correlationId, tables: [...WRITE_TABLES] },
      async (tx) => {
        const [row] = await tx.query<Row[]>(ANNOUNCEMENTS_SQL.byId, [id]);
        if (!row || bool(row['archived'])) return false;
        await tx.query(statement, params);
        await insertPlatformAudit(tx, audit);
        return true;
      },
    );
  }
}
