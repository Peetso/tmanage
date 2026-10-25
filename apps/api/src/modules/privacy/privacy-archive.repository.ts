import { gzipSync } from 'node:zlib';
import type {
  QueryRows,
  SqlParameter,
  TenantContext,
  TenantDatabase,
} from '../../common/database/tenant-context.js';
import type { ArchiveFileContents } from './privacy-archive-files.repository.js';

/**
 * D5 (Figma F5) — what goes into a data export, and how it is packed.
 *
 * The archive is one gzip-compressed JSON document (`.json.gz`): a header naming the studio, the
 * kind and the time, then one array of rows per section. Rows are read through the tenant database,
 * so every section of a company export carries the organization predicate the guard demands, and a
 * member export narrows each section to the one person as well. The identity half of a member export
 * (their account and their sign-in history) is read on the identity path, which may reach only the
 * global tables it names.
 *
 * S13 / F46 — **which door asked decides the sign-in history.** The person's own export (they asked,
 * about themselves) carries their whole platform sign-in history. An export an owner asked for about
 * someone else carries only the attempts made while that person belonged to *this* organization
 * (from the membership's `created_at`, to its offboarding when it has ended), and without `ip` or
 * `user_agent`: what they did elsewhere, and where and on what device, is not this company's.
 *
 * What is deliberately left out: credentials of any kind (password hashes, MFA seeds, tokens,
 * session secrets).
 *
 * File **bytes** (H3) are in the `file_contents` section, base64, read by {@link ArchiveFileContents}
 * under the download route's scan policy: a file that would not be served is listed with the reason
 * it was left out instead of its bytes, and the whole archive is scanned again before it is stored.
 */

/** A company section: one tenant table, read whole (in pages) by its organization. */
export const COMPANY_SECTIONS: readonly { readonly name: string; readonly table: string }[] = [
  { name: 'members', table: 'memberships' },
  { name: 'member_profiles', table: 'member_profiles' },
  { name: 'workspaces', table: 'workspaces' },
  { name: 'projects', table: 'projects' },
  { name: 'project_memberships', table: 'project_memberships' },
  { name: 'work_items', table: 'work_items' },
  { name: 'work_item_comments', table: 'work_item_comments' },
  { name: 'conversations', table: 'conversations' },
  { name: 'messages', table: 'messages' },
  { name: 'direct_conversations', table: 'direct_conversations' },
  { name: 'direct_messages', table: 'direct_messages' },
  { name: 'documents', table: 'documents' },
  { name: 'document_versions', table: 'document_versions' },
  { name: 'decisions', table: 'decisions' },
  { name: 'meetings', table: 'meetings' },
  { name: 'client_organizations', table: 'client_organizations' },
  { name: 'client_requests', table: 'client_requests' },
  { name: 'files', table: 'file_assets' },
  { name: 'file_versions', table: 'file_versions' },
  { name: 'audit_log', table: 'audit_events' },
];

/** A member section: one tenant table narrowed to the rows that person wrote or owns. */
export const MEMBER_SECTIONS: readonly {
  readonly name: string;
  readonly table: string;
  readonly personColumn: string;
}[] = [
  { name: 'membership', table: 'memberships', personColumn: 'user_id' },
  { name: 'profile_in_studio', table: 'member_profiles', personColumn: 'user_id' },
  { name: 'messages', table: 'messages', personColumn: 'author_user_id' },
  { name: 'direct_messages', table: 'direct_messages', personColumn: 'author_user_id' },
  { name: 'files_added', table: 'file_assets', personColumn: 'owner_user_id' },
];

const PAGE_SIZE = 1000;
/** A ceiling per section so one runaway table cannot exhaust the process; the archive says so. */
export const MAX_ROWS_PER_SECTION = 200_000;

export type ArchiveRow = Record<string, unknown>;

/**
 * Who the member archive is for: `'self'` when the subject asked about themselves, `'owner'` when an
 * owner asked about someone else. The narrow `'owner'` reading is the default.
 */
export type ArchiveDoor = 'self' | 'owner';

/** The door an export row came through: only a person asking about themselves is `'self'`. */
export function archiveDoorOf(row: {
  readonly requestedByUserId: string;
  readonly subjectUserId: string | null;
}): ArchiveDoor {
  return row.subjectUserId !== null && row.requestedByUserId === row.subjectUserId
    ? 'self'
    : 'owner';
}

export interface ArchiveHeader {
  readonly format: 'tmanage-data-export';
  readonly formatVersion: 1;
  readonly kind: 'company' | 'member';
  readonly organization: { readonly id: string; readonly name: string };
  readonly subjectUserId: string | null;
  readonly generatedAt: string;
}

export interface ArchiveDocument extends ArchiveHeader {
  readonly sections: Record<string, readonly ArchiveRow[]>;
  /** Sections cut at {@link MAX_ROWS_PER_SECTION}. Empty in the ordinary case. */
  readonly truncatedSections: readonly string[];
}

/** One JSON-safe value: dates as ISO strings, bytes as base64, big integers as strings. */
export function toJsonValue(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (Buffer.isBuffer(value)) return value.toString('base64');
  if (typeof value === 'bigint') return value.toString();
  return value;
}

export function toJsonRow(row: Record<string, unknown>): ArchiveRow {
  const out: ArchiveRow = {};
  for (const [key, value] of Object.entries(row)) out[key] = toJsonValue(value);
  return out;
}

/** Pack the document: UTF-8 JSON, gzip-compressed. */
export function packArchive(document: ArchiveDocument): Buffer {
  return gzipSync(Buffer.from(JSON.stringify(document), 'utf8'));
}

/** The archive's download name: `tmanage-export-<kind>-<yyyy-mm-dd>.json.gz`. */
export function archiveFileName(kind: 'company' | 'member', completedAt: Date): string {
  return `tmanage-export-${kind}-${completedAt.toISOString().slice(0, 10)}.json.gz`;
}

/** Table and column names are this file's constants; the check keeps them out of any input path. */
const IDENTIFIER = /^[a-z][a-z0-9_]*$/;

function identifier(name: string): string {
  if (!IDENTIFIER.test(name)) throw new Error(`not a plain identifier: ${name}`);
  return `\`${name}\``;
}

/** Reads the sections. `onProgress` is told the share done (0..1) after each section. */
export class PrivacyArchiveBuilder {
  /** @param files absent: the archive carries file metadata only (a suite that reads no store). */
  constructor(
    private readonly database: TenantDatabase,
    private readonly files?: Pick<ArchiveFileContents, 'read'>,
  ) {}

  async build(
    context: TenantContext,
    header: ArchiveHeader,
    onProgress: (share: number) => Promise<void>,
    door: ArchiveDoor = 'owner',
  ): Promise<ArchiveDocument> {
    const sections: Record<string, readonly ArchiveRow[]> = {};
    const truncated: string[] = [];

    if (header.kind === 'company') {
      for (const [index, section] of COMPANY_SECTIONS.entries()) {
        const { rows, cut } = await this.readSection(context, section.table, null, null);
        sections[section.name] = rows;
        if (cut) truncated.push(section.name);
        await onProgress((index + 1) / COMPANY_SECTIONS.length);
      }
    } else {
      const subject = header.subjectUserId;
      if (subject === null) throw new Error('a member export names its subject');
      const identity = await this.readIdentity(context, subject, door);
      sections['account'] = identity.account;
      sections['sign_in_history'] = identity.signIns;
      for (const [index, section] of MEMBER_SECTIONS.entries()) {
        const { rows, cut } = await this.readSection(
          context,
          section.table,
          section.personColumn,
          subject,
        );
        sections[section.name] = rows;
        if (cut) truncated.push(section.name);
        await onProgress((index + 1) / MEMBER_SECTIONS.length);
      }
    }

    if (this.files !== undefined) {
      const owner = header.kind === 'company' ? null : header.subjectUserId;
      sections['file_contents'] = (await this.files.read(context, owner)).map((row) => ({
        ...row,
      }));
    }

    return { ...header, sections, truncatedSections: truncated };
  }

  private async readSection(
    context: TenantContext,
    table: string,
    personColumn: string | null,
    personId: string | null,
  ): Promise<{ readonly rows: readonly ArchiveRow[]; readonly cut: boolean }> {
    const rows: ArchiveRow[] = [];
    const where =
      personColumn === null
        ? `organization_id = ?`
        : `organization_id = ? and ${identifier(personColumn)} = ?`;
    for (let offset = 0; offset < MAX_ROWS_PER_SECTION; offset += PAGE_SIZE) {
      const params: SqlParameter[] = [context.organizationId];
      if (personId !== null) params.push(personId);
      const page = await this.database.read(context, (runner) =>
        runner.query(
          `select * from ${identifier(table)} where ${where} order by id limit ${String(
            PAGE_SIZE,
          )} offset ${String(offset)}`,
          params,
        ),
      );
      for (const row of page) rows.push(toJsonRow(row as Record<string, unknown>));
      if (page.length < PAGE_SIZE) return { rows, cut: false };
    }
    return { rows, cut: true };
  }

  /**
   * The person's account (no credential columns) and their sign-in attempts, newest first: all of
   * them through the person's own door, only this membership's lifetime and no address or device
   * through the owner's (F46).
   */
  private async readIdentity(
    context: TenantContext,
    userId: string,
    door: ArchiveDoor,
  ): Promise<{ readonly account: readonly ArchiveRow[]; readonly signIns: readonly ArchiveRow[] }> {
    const window = door === 'self' ? null : await this.membershipWindow(context, userId);
    return this.database.identityRead(
      { correlationId: context.correlationId, tables: ['users', 'authentication_events'] },
      async (runner) => {
        const account = await runner.query(
          `select id, email, display_name, locale, timezone, email_verified_at, created_at, updated_at
             from users where id = ?`,
          [userId],
        );
        let signIns: QueryRows;
        if (door === 'self') {
          signIns = await runner.query<QueryRows>(
            `select action, outcome, ip, user_agent, occurred_at
               from authentication_events where user_id = ?
               order by occurred_at desc limit 1000`,
            [userId],
          );
        } else if (window === null) {
          // No membership here (it cannot be read): nothing of theirs is this company's to see.
          signIns = [];
        } else {
          const params: SqlParameter[] = [userId, window.from];
          if (window.to !== null) params.push(window.to);
          signIns = await runner.query<QueryRows>(
            `select action, outcome, occurred_at
               from authentication_events where user_id = ? and occurred_at >= ?${
                 window.to === null ? '' : ' and occurred_at <= ?'
               }
               order by occurred_at desc limit 1000`,
            params,
          );
        }
        return {
          account: account.map((row) => toJsonRow(row as Record<string, unknown>)),
          signIns: signIns.map((row) => toJsonRow(row as Record<string, unknown>)),
        };
      },
    );
  }

  /** When the person joined this organization, and when they left it (null while they belong). */
  private async membershipWindow(
    context: TenantContext,
    userId: string,
  ): Promise<{ readonly from: Date; readonly to: Date | null } | null> {
    const rows = await this.database.read(context, (runner) =>
      runner.query(
        `select created_at, status, updated_at from memberships
           where organization_id = ? and user_id = ? limit 1`,
        [context.organizationId, userId],
      ),
    );
    const row = rows[0] as Record<string, unknown> | undefined;
    const from = asDate(row?.['created_at']);
    if (!row || from === null) return null;
    return { from, to: row['status'] === 'offboarded' ? asDate(row['updated_at']) : null };
  }
}

function asDate(value: unknown): Date | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value === 'string' || typeof value === 'number') {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  return null;
}
