import { gzipSync } from 'node:zlib';
import type {
  SqlParameter,
  TenantContext,
  TenantDatabase,
} from '../../common/database/tenant-context.js';

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
 * What is deliberately left out: credentials of any kind (password hashes, MFA seeds, tokens,
 * session secrets) and file **bytes** — a file appears as its metadata row; its contents stay behind
 * the download route and its scan policy.
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
  constructor(private readonly database: TenantDatabase) {}

  async build(
    context: TenantContext,
    header: ArchiveHeader,
    onProgress: (share: number) => Promise<void>,
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
      const identity = await this.readIdentity(context, subject);
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

  /** The person's account (no credential columns) and their sign-in attempts, newest first. */
  private async readIdentity(
    context: TenantContext,
    userId: string,
  ): Promise<{ readonly account: readonly ArchiveRow[]; readonly signIns: readonly ArchiveRow[] }> {
    return this.database.identityRead(
      { correlationId: context.correlationId, tables: ['users', 'authentication_events'] },
      async (runner) => {
        const account = await runner.query(
          `select id, email, display_name, locale, timezone, email_verified_at, created_at, updated_at
             from users where id = ?`,
          [userId],
        );
        const signIns = await runner.query(
          `select action, outcome, ip, user_agent, occurred_at
             from authentication_events where user_id = ?
             order by occurred_at desc limit 1000`,
          [userId],
        );
        return {
          account: account.map((row) => toJsonRow(row as Record<string, unknown>)),
          signIns: signIns.map((row) => toJsonRow(row as Record<string, unknown>)),
        };
      },
    );
  }
}
