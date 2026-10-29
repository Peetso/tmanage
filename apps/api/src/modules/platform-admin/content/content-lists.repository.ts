import type {
  QueryRows,
  SqlParameter,
  TenantContext,
  TenantQueryRunner,
} from '../../../common/database/tenant-context.js';
import {
  contentPurgeDays,
  normaliseDeletedReason,
} from '../../../common/database/content-retention.js';
import { likeContains } from '../platform-admin.access.js';
import { CONTENT_KIND_DEFINITIONS } from './content-kinds.js';
import type { ContentArea, ContentKind } from './content-kinds.js';

/**
 * platform-admin v2 · PA-08 — the content browser's own statements (SPEC §5.4 implementation note).
 *
 * Only what the organization's modules have no statement for lives here: the list and search
 * queries of the browser (they show struck-through deleted rows the members' lists hide), the trash
 * (B7, every kind's soft-deleted rows), the restore that clears `deleted_*`, the soft delete of the
 * kinds whose module never deletes, and an object's audit history with its before/after rows.
 *
 * Every statement runs on the tenant runner of the Support session's context and names
 * `organization_id = ?` for EVERY tenant table it touches (joins included), bound to that one
 * organization — the tenant guard checks it. No UNION and no sub-select: the trash is one small
 * query per kind, merged here.
 */

type Row = Record<string, unknown>;

/** `deleted=only` lists only removed rows; `exclude` hides them; default shows both (struck). */
export type DeletedFilter = 'include' | 'only' | 'exclude';

export interface ListFilters {
  readonly q?: string | null;
  readonly projectId?: string | null;
  readonly deleted: DeletedFilter;
  readonly limit: number;
}

/** One row of any list, the shape every area table and list draws from. */
export interface ContentRecord {
  readonly kind: ContentKind;
  readonly id: string;
  /** The conversation (messages), the object (comments), the request (request messages). */
  readonly parentId: string | null;
  readonly title: string;
  readonly preview: string | null;
  readonly projectId: string | null;
  readonly projectName: string | null;
  readonly authorUserId: string | null;
  readonly authorName: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date | null;
  readonly deletedAt: Date | null;
  readonly deletedByUserId: string | null;
  readonly deletedReason: string | null;
  readonly purgeAfter: Date | null;
  readonly state: string | null;
  readonly audience: string | null;
  readonly location: 'local' | 'google_drive' | 'onedrive' | null;
  readonly sizeBytes: number | null;
  readonly versions: number | null;
  readonly edited: boolean;
  readonly replies: number | null;
  readonly dueAt: Date | null;
  readonly sequenceNo: number | null;
}

export interface HistoryRecord {
  readonly id: string;
  readonly action: string;
  readonly result: string;
  readonly createdAt: Date;
  readonly actorUserId: string | null;
  readonly actorName: string | null;
  readonly effectiveActorId: string | null;
  readonly supportSessionId: string | null;
  readonly ip: string | null;
  readonly userAgent: string | null;
  readonly changes: readonly {
    readonly field: string;
    readonly before: string | null;
    readonly after: string | null;
    readonly redacted: boolean;
  }[];
}

export interface DeliverableVersionRecord {
  readonly id: string;
  readonly deliverableId: string;
  readonly deliverableTitle: string;
  readonly versionNo: number;
  readonly fileAssetId: string | null;
  readonly fileName: string | null;
  readonly createdAt: Date;
  /** The newest approval's state for this version, or null when none was asked. */
  readonly approvalState: string | null;
  readonly approvedAt: Date | null;
  readonly approvedByName: string | null;
}

export type AreaCounts = Readonly<Record<ContentArea, number>>;

// ── helpers ─────────────────────────────────────────────────────────────────

function date(value: unknown): Date | null {
  if (value === null || value === undefined) return null;
  const parsed = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function text(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

function num(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** A one-line preview of a body, never more than 160 characters. */
export function previewOf(value: unknown): string | null {
  const raw = text(value);
  if (raw === null) return null;
  const line = raw.replace(/\s+/gu, ' ').trim();
  if (line === '') return null;
  return line.length > 160 ? `${line.slice(0, 157)}…` : line;
}

function deletedPredicate(alias: string, filter: DeletedFilter): string {
  if (filter === 'only') return ` and ${alias}.deleted_at is not null`;
  if (filter === 'exclude') return ` and ${alias}.deleted_at is null`;
  return '';
}

function base(row: Row, kind: ContentKind): Omit<ContentRecord, 'title' | 'preview'> {
  return {
    kind,
    id: String(row['id']),
    parentId: text(row['parent_id']),
    projectId: text(row['project_id']),
    projectName: text(row['project_name']),
    authorUserId: text(row['author_user_id']),
    authorName: text(row['author_name']),
    createdAt: date(row['created_at']) ?? new Date(0),
    updatedAt: date(row['updated_at']),
    deletedAt: date(row['deleted_at']),
    deletedByUserId: text(row['deleted_by_user_id']),
    deletedReason: text(row['deleted_reason']),
    purgeAfter: date(row['purge_after']),
    state: text(row['state']),
    audience: text(row['audience']),
    location: null,
    sizeBytes: null,
    versions: null,
    edited: row['edited_at'] !== null && row['edited_at'] !== undefined,
    replies: null,
    dueAt: date(row['due_at']),
    sequenceNo: num(row['sequence_no']),
  };
}

const DELETED_COLS = (alias: string) =>
  `${alias}.deleted_at as deleted_at, ${alias}.deleted_by_user_id as deleted_by_user_id,
   ${alias}.deleted_reason as deleted_reason, ${alias}.purge_after as purge_after`;

/** The comment tables, with the column naming the object they hang off. */
const COMMENT_SOURCES: readonly {
  readonly kind: ContentKind;
  readonly objectColumn: string;
}[] = [
  { kind: 'work_comment', objectColumn: 'work_item_id' },
  { kind: 'doc_comment', objectColumn: 'document_id' },
  { kind: 'decision_comment', objectColumn: 'decision_id' },
  { kind: 'file_comment', objectColumn: 'file_asset_id' },
  { kind: 'request_comment', objectColumn: 'request_id' },
  { kind: 'update_comment', objectColumn: 'update_id' },
];

export class ContentListsRepository {
  /** The organization's name and slug, for the B5–B7 header. */
  async organization(
    runner: TenantQueryRunner,
    organizationId: string,
  ): Promise<{ readonly id: string; readonly name: string; readonly slug: string } | null> {
    const rows = await runner.query<QueryRows>(
      'select o.id as id, o.name as name, o.slug as slug from organizations o where o.id = ? limit 1',
      [organizationId],
    );
    const row = rows[0];
    if (!row) return null;
    return { id: String(row['id']), name: String(row['name']), slug: String(row['slug']) };
  }

  // ── Counts (the area tabs) ─────────────────────────────────────────────────

  async counts(runner: TenantQueryRunner, context: TenantContext): Promise<AreaCounts> {
    const org = context.organizationId;
    const one = async (sql: string): Promise<number> => {
      const rows = await runner.query<QueryRows>(sql, [org]);
      return num(rows[0]?.['n']) ?? 0;
    };
    const comments = await Promise.all(
      COMMENT_SOURCES.map((source) =>
        one(
          `select count(*) as n from ${CONTENT_KIND_DEFINITIONS[source.kind].table} c where c.organization_id = ?`,
        ),
      ),
    );
    const files = await Promise.all([
      one('select count(*) as n from file_assets f where f.organization_id = ?'),
      one('select count(*) as n from google_drive_attachments g where g.organization_id = ?'),
      one('select count(*) as n from onedrive_attachments o where o.organization_id = ?'),
    ]);
    return {
      chats: await one('select count(*) as n from conversations c where c.organization_id = ?'),
      dms: await one(
        'select count(*) as n from direct_conversations d where d.organization_id = ?',
      ),
      work_items: await one('select count(*) as n from work_items w where w.organization_id = ?'),
      comments: comments.reduce((sum, n) => sum + n, 0),
      docs: await one('select count(*) as n from documents d where d.organization_id = ?'),
      decisions: await one('select count(*) as n from decisions d where d.organization_id = ?'),
      meetings: await one('select count(*) as n from meetings m where m.organization_id = ?'),
      files: files.reduce((sum, n) => sum + n, 0),
      requests: await one(
        'select count(*) as n from client_requests r where r.organization_id = ?',
      ),
    };
  }

  /** How many rows are in the trash (the "Deleted items · 12" button). */
  async trashCount(runner: TenantQueryRunner, context: TenantContext): Promise<number> {
    let total = 0;
    for (const definition of new Set(Object.values(CONTENT_KIND_DEFINITIONS).map((d) => d.table))) {
      const rows = await runner.query<QueryRows>(
        `select count(*) as n from ${definition} t where t.organization_id = ? and t.deleted_at is not null`,
        [context.organizationId],
      );
      total += num(rows[0]?.['n']) ?? 0;
    }
    return total;
  }

  // ── Chats and DMs ──────────────────────────────────────────────────────────

  async listChannels(
    runner: TenantQueryRunner,
    context: TenantContext,
    filters: ListFilters,
  ): Promise<ContentRecord[]> {
    const org = context.organizationId;
    const params: SqlParameter[] = [org, org, org];
    let where = '';
    if (filters.q) {
      where += " and c.name like ? escape '\\\\'";
      params.push(likeContains(filters.q));
    }
    if (filters.projectId) {
      where += ' and c.project_id = ?';
      params.push(filters.projectId);
    }
    if (filters.deleted === 'only') where += ' and c.archived_at is not null';
    params.push(filters.limit);
    const rows = await runner.query<QueryRows>(
      `select c.id as id, c.name as name, c.project_id as project_id, p.name as project_name,
              c.created_at as created_at, c.updated_at as updated_at, c.archived_at as archived_at,
              m.body as last_body, m.created_at as last_at, m.deleted_at as last_deleted_at,
              u.display_name as last_author
         from conversations c
         left join projects p on p.organization_id = ? and p.id = c.project_id
         left join messages m on m.organization_id = ? and m.conversation_id = c.id
              and m.sequence_no = c.next_sequence_no - 1
         left join users u on u.id = m.author_user_id
        where c.organization_id = ?${where}
        order by coalesce(m.created_at, c.updated_at) desc, c.id desc
        limit ?`,
      params,
    );
    return rows.map((row) => {
      const last = row['last_deleted_at'] ? null : previewOf(row['last_body']);
      const author = text(row['last_author']);
      return {
        ...base(row, 'message'),
        kind: 'message',
        title: `# ${String(row['name'])}`,
        preview: last === null ? null : author ? `${author}: ${last}` : last,
        updatedAt: date(row['last_at']) ?? date(row['updated_at']),
        state: row['archived_at'] ? 'archived' : 'active',
      } satisfies ContentRecord;
    });
  }

  async listDirectConversations(
    runner: TenantQueryRunner,
    context: TenantContext,
    filters: ListFilters,
  ): Promise<ContentRecord[]> {
    const org = context.organizationId;
    const params: SqlParameter[] = [org, org];
    let where = deletedPredicate('d', filters.deleted);
    if (filters.q) {
      where +=
        " and (ul.display_name like ? escape '\\\\' or uh.display_name like ? escape '\\\\')";
      params.push(likeContains(filters.q), likeContains(filters.q));
    }
    params.push(filters.limit);
    const rows = await runner.query<QueryRows>(
      `select d.id as id, ul.display_name as low_name, uh.display_name as high_name,
              d.created_at as created_at, d.last_message_at as updated_at, ${DELETED_COLS('d')},
              m.body as last_body, m.deleted_at as last_deleted_at, ua.display_name as last_author
         from direct_conversations d
         join users ul on ul.id = d.user_low_id
         join users uh on uh.id = d.user_high_id
         left join direct_messages m on m.organization_id = ? and m.direct_conversation_id = d.id
              and m.sequence_no = d.next_sequence_no - 1
         left join users ua on ua.id = m.author_user_id
        where d.organization_id = ?${where}
        order by coalesce(d.last_message_at, d.created_at) desc, d.id desc
        limit ?`,
      params,
    );
    return rows.map((row) => {
      const last = row['last_deleted_at'] ? null : previewOf(row['last_body']);
      const author = text(row['last_author']);
      return {
        ...base(row, 'direct_message'),
        title: `${String(row['low_name'])} · ${String(row['high_name'])}`,
        preview: last === null ? null : author ? `${author}: ${last}` : last,
      };
    });
  }

  /** Top-level messages of a channel (or one thread's replies), newest page first. */
  async listMessages(
    runner: TenantQueryRunner,
    context: TenantContext,
    conversationId: string,
    options: {
      readonly parentMessageId: string | null;
      readonly before: number | null;
      readonly after: number | null;
      readonly limit: number;
    },
  ): Promise<ContentRecord[]> {
    const org = context.organizationId;
    const params: SqlParameter[] = [org, conversationId];
    let where = '';
    if (options.parentMessageId) {
      where += ' and m.parent_message_id = ?';
      params.push(options.parentMessageId);
    } else {
      where += ' and m.parent_message_id is null';
    }
    if (options.before !== null) {
      where += ' and m.sequence_no < ?';
      params.push(options.before);
    }
    if (options.after !== null) {
      where += ' and m.sequence_no > ?';
      params.push(options.after);
    }
    params.push(options.limit);
    const rows = await runner.query<QueryRows>(
      `select m.id as id, m.conversation_id as parent_id, m.author_user_id as author_user_id,
              u.display_name as author_name, m.body as body, m.sequence_no as sequence_no,
              m.created_at as created_at, m.updated_at as updated_at, m.edited_at as edited_at,
              ${DELETED_COLS('m')}
         from messages m
         left join users u on u.id = m.author_user_id
        where m.organization_id = ? and m.conversation_id = ?${where}
        order by m.sequence_no desc
        limit ?`,
      params,
    );
    const records = rows.map((row) => ({
      ...base(row, 'message'),
      title: String(row['author_name'] ?? ''),
      preview: text(row['body']),
    }));
    if (records.length === 0) return records;
    const replies = await runner.query<QueryRows>(
      `select r.parent_message_id as parent_id, count(*) as n from messages r
        where r.organization_id = ? and r.parent_message_id in (${records.map(() => '?').join(', ')})
        group by r.parent_message_id`,
      [org, ...records.map((r) => r.id)],
    );
    const counts = new Map(replies.map((r) => [String(r['parent_id']), num(r['n']) ?? 0]));
    return records.map((record) => ({ ...record, replies: counts.get(record.id) ?? 0 })).reverse();
  }

  async listDirectMessages(
    runner: TenantQueryRunner,
    context: TenantContext,
    directConversationId: string,
    options: {
      readonly before: number | null;
      readonly after: number | null;
      readonly limit: number;
    },
  ): Promise<ContentRecord[]> {
    const params: SqlParameter[] = [context.organizationId, directConversationId];
    let where = '';
    if (options.before !== null) {
      where += ' and m.sequence_no < ?';
      params.push(options.before);
    }
    if (options.after !== null) {
      where += ' and m.sequence_no > ?';
      params.push(options.after);
    }
    params.push(options.limit);
    const rows = await runner.query<QueryRows>(
      `select m.id as id, m.direct_conversation_id as parent_id, m.author_user_id as author_user_id,
              u.display_name as author_name, m.body as body, m.sequence_no as sequence_no,
              m.created_at as created_at, ${DELETED_COLS('m')}
         from direct_messages m
         left join users u on u.id = m.author_user_id
        where m.organization_id = ? and m.direct_conversation_id = ?${where}
        order by m.sequence_no desc
        limit ?`,
      params,
    );
    return rows
      .map((row) => ({
        ...base(row, 'direct_message'),
        title: String(row['author_name'] ?? ''),
        preview: text(row['body']),
      }))
      .reverse();
  }

  // ── Work items ─────────────────────────────────────────────────────────────

  async listWorkItems(
    runner: TenantQueryRunner,
    context: TenantContext,
    filters: ListFilters & { readonly state?: string | null; readonly assignee?: string | null },
  ): Promise<ContentRecord[]> {
    const org = context.organizationId;
    const params: SqlParameter[] = [org, org];
    let where = deletedPredicate('w', filters.deleted);
    if (filters.q) {
      where += " and w.title like ? escape '\\\\'";
      params.push(likeContains(filters.q));
    }
    if (filters.projectId) {
      where += ' and w.project_id = ?';
      params.push(filters.projectId);
    }
    if (filters.state) {
      where += ' and w.state = ?';
      params.push(filters.state);
    }
    if (filters.assignee) {
      where += ' and w.owner_user_id = ?';
      params.push(filters.assignee);
    }
    params.push(filters.limit);
    const rows = await runner.query<QueryRows>(
      `select w.id as id, w.title as title, w.description as description, w.state as state,
              w.audience as audience, w.project_id as project_id, p.name as project_name,
              w.owner_user_id as author_user_id, u.display_name as author_name, w.due_at as due_at,
              w.created_at as created_at, w.updated_at as updated_at, ${DELETED_COLS('w')}
         from work_items w
         left join projects p on p.organization_id = ? and p.id = w.project_id
         left join users u on u.id = w.owner_user_id
        where w.organization_id = ?${where}
        order by w.updated_at desc, w.id desc
        limit ?`,
      params,
    );
    return rows.map((row) => ({
      ...base(row, 'work_item'),
      title: String(row['title']),
      preview: previewOf(row['description']),
    }));
  }

  // ── Comments ───────────────────────────────────────────────────────────────

  async listComments(
    runner: TenantQueryRunner,
    context: TenantContext,
    filters: ListFilters & {
      readonly kind?: ContentKind | null;
      readonly objectId?: string | null;
      readonly author?: string | null;
    },
  ): Promise<ContentRecord[]> {
    const sources = filters.kind
      ? COMMENT_SOURCES.filter((source) => source.kind === filters.kind)
      : COMMENT_SOURCES;
    const all: ContentRecord[] = [];
    for (const source of sources) {
      const definition = CONTENT_KIND_DEFINITIONS[source.kind];
      const org = context.organizationId;
      const params: SqlParameter[] = [];
      let join: string;
      let authorUser: string;
      if (definition.authorIsMembership) {
        join = `left join memberships am on am.organization_id = ? and am.id = c.${definition.authorColumn ?? 'id'}
                left join users u on u.id = am.user_id`;
        params.push(org);
        authorUser = 'am.user_id';
      } else {
        join = `left join users u on u.id = c.${definition.authorColumn ?? 'id'}`;
        authorUser = `c.${definition.authorColumn ?? 'id'}`;
      }
      params.push(org);
      let where = deletedPredicate('c', filters.deleted);
      if (filters.q) {
        where += " and c.body like ? escape '\\\\'";
        params.push(likeContains(filters.q));
      }
      if (filters.objectId) {
        where += ` and c.${source.objectColumn} = ?`;
        params.push(filters.objectId);
      }
      if (filters.author) {
        where += ` and ${authorUser} = ?`;
        params.push(filters.author);
      }
      params.push(filters.limit);
      const rows = await runner.query<QueryRows>(
        `select c.id as id, c.${source.objectColumn} as parent_id, c.body as body,
                ${authorUser} as author_user_id, u.display_name as author_name,
                c.created_at as created_at, ${DELETED_COLS('c')}
           from ${definition.table} c
           ${join}
          where c.organization_id = ?${where}
          order by c.created_at desc, c.id desc
          limit ?`,
        params,
      );
      for (const row of rows) {
        all.push({
          ...base(row, source.kind),
          title: previewOf(row['body']) ?? '',
          preview: text(row['body']),
        });
      }
    }
    return all
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .slice(0, filters.limit);
  }

  // ── Docs, decisions, meetings ──────────────────────────────────────────────

  async listDocs(
    runner: TenantQueryRunner,
    context: TenantContext,
    filters: ListFilters,
  ): Promise<ContentRecord[]> {
    const org = context.organizationId;
    const params: SqlParameter[] = [org, org];
    let where = deletedPredicate('d', filters.deleted);
    if (filters.q) {
      where += " and d.title like ? escape '\\\\'";
      params.push(likeContains(filters.q));
    }
    if (filters.projectId) {
      where += ' and d.project_id = ?';
      params.push(filters.projectId);
    }
    params.push(filters.limit);
    const rows = await runner.query<QueryRows>(
      `select d.id as id, d.title as title, d.body as body, d.audience as audience,
              d.project_id as project_id, p.name as project_name,
              d.created_by_user_id as author_user_id, u.display_name as author_name,
              d.created_at as created_at, d.updated_at as updated_at,
              case when d.published_at is null then 'draft' else 'published' end as state,
              ${DELETED_COLS('d')}
         from documents d
         left join projects p on p.organization_id = ? and p.id = d.project_id
         left join users u on u.id = d.created_by_user_id
        where d.organization_id = ?${where}
        order by d.updated_at desc, d.id desc
        limit ?`,
      params,
    );
    return rows.map((row) => ({
      ...base(row, 'doc'),
      title: String(row['title']),
      preview: previewOf(row['body']),
    }));
  }

  async listDecisions(
    runner: TenantQueryRunner,
    context: TenantContext,
    filters: ListFilters,
  ): Promise<ContentRecord[]> {
    const org = context.organizationId;
    const params: SqlParameter[] = [org, org];
    let where = deletedPredicate('d', filters.deleted);
    if (filters.q) {
      where += " and d.title like ? escape '\\\\'";
      params.push(likeContains(filters.q));
    }
    if (filters.projectId) {
      where += ' and d.project_id = ?';
      params.push(filters.projectId);
    }
    params.push(filters.limit);
    const rows = await runner.query<QueryRows>(
      `select d.id as id, d.title as title, d.statement as statement, d.status as state,
              d.audience as audience, d.project_id as project_id, p.name as project_name,
              d.decided_by as author_user_id, u.display_name as author_name,
              d.created_at as created_at, d.decided_at as updated_at, ${DELETED_COLS('d')}
         from decisions d
         left join projects p on p.organization_id = ? and p.id = d.project_id
         left join users u on u.id = d.decided_by
        where d.organization_id = ?${where}
        order by d.created_at desc, d.id desc
        limit ?`,
      params,
    );
    return rows.map((row) => ({
      ...base(row, 'decision'),
      title: String(row['title']),
      preview: previewOf(row['statement']),
    }));
  }

  async listMeetings(
    runner: TenantQueryRunner,
    context: TenantContext,
    filters: ListFilters,
  ): Promise<ContentRecord[]> {
    const org = context.organizationId;
    const params: SqlParameter[] = [org, org];
    let where = deletedPredicate('m', filters.deleted);
    if (filters.q) {
      where += " and m.title like ? escape '\\\\'";
      params.push(likeContains(filters.q));
    }
    if (filters.projectId) {
      where += ' and m.project_id = ?';
      params.push(filters.projectId);
    }
    params.push(filters.limit);
    const rows = await runner.query<QueryRows>(
      `select m.id as id, m.title as title, m.agenda_note as agenda_note,
              m.project_id as project_id, p.name as project_name,
              m.created_by_user_id as author_user_id, u.display_name as author_name,
              m.starts_at as due_at, m.created_at as created_at, m.updated_at as updated_at,
              case when m.cancelled_at is null then 'scheduled' else 'cancelled' end as state,
              ${DELETED_COLS('m')}
         from meetings m
         left join projects p on p.organization_id = ? and p.id = m.project_id
         left join users u on u.id = m.created_by_user_id
        where m.organization_id = ?${where}
        order by m.starts_at desc, m.id desc
        limit ?`,
      params,
    );
    return rows.map((row) => ({
      ...base(row, 'meeting'),
      title: String(row['title']),
      preview: previewOf(row['agenda_note']),
    }));
  }

  // ── Files ──────────────────────────────────────────────────────────────────

  async listFiles(
    runner: TenantQueryRunner,
    context: TenantContext,
    filters: ListFilters & { readonly location?: string | null; readonly scan?: string | null },
  ): Promise<ContentRecord[]> {
    const org = context.organizationId;
    const out: ContentRecord[] = [];
    const wantLocal = !filters.location || filters.location === 'local';
    if (wantLocal) {
      const params: SqlParameter[] = [org, org];
      let where = deletedPredicate('f', filters.deleted);
      if (filters.q) {
        where += " and f.name like ? escape '\\\\'";
        params.push(likeContains(filters.q));
      }
      if (filters.projectId) {
        where += ' and f.project_id = ?';
        params.push(filters.projectId);
      }
      params.push(filters.limit);
      const rows = await runner.query<QueryRows>(
        `select f.id as id, f.name as name, f.status as state, f.audience as audience,
                f.project_id as project_id, p.name as project_name,
                f.owner_user_id as author_user_id, u.display_name as author_name,
                f.created_at as created_at, f.updated_at as updated_at, ${DELETED_COLS('f')}
           from file_assets f
           left join projects p on p.organization_id = ? and p.id = f.project_id
           left join users u on u.id = f.owner_user_id
          where f.organization_id = ?${where}
          order by f.updated_at desc, f.id desc
          limit ?`,
        params,
      );
      const records = rows.map((row) => ({
        ...base(row, 'file'),
        title: String(row['name']),
        preview: null,
        location: 'local' as const,
      }));
      const versions = await this.fileVersionFacts(
        runner,
        context,
        records.map((r) => r.id),
      );
      for (const record of records) {
        const facts = versions.get(record.id);
        out.push({
          ...record,
          sizeBytes: facts?.sizeBytes ?? null,
          versions: facts?.count ?? 0,
        });
      }
    }
    for (const [kind, table, location] of [
      ['drive_file', 'google_drive_attachments', 'google_drive'],
      ['onedrive_file', 'onedrive_attachments', 'onedrive'],
    ] as const) {
      if (filters.location && filters.location !== location) continue;
      const params: SqlParameter[] = [org, org];
      let where = deletedPredicate('a', filters.deleted);
      if (filters.q) {
        where += " and a.name like ? escape '\\\\'";
        params.push(likeContains(filters.q));
      }
      if (filters.projectId) {
        where += ' and w.project_id = ?';
        params.push(filters.projectId);
      }
      params.push(filters.limit);
      const rows = await runner.query<QueryRows>(
        `select a.id as id, a.name as name, a.size_bytes as size_bytes, a.work_item_id as parent_id,
                w.project_id as project_id, a.attached_by_user_id as author_user_id,
                u.display_name as author_name, a.created_at as created_at, ${DELETED_COLS('a')}
           from ${table} a
           left join work_items w on w.organization_id = ? and w.id = a.work_item_id
           left join users u on u.id = a.attached_by_user_id
          where a.organization_id = ?${where}
          order by a.created_at desc, a.id desc
          limit ?`,
        params,
      );
      for (const row of rows) {
        out.push({
          ...base(row, kind),
          title: String(row['name']),
          preview: null,
          location,
          state: 'linked',
          sizeBytes: num(row['size_bytes']),
          versions: 1,
        });
      }
    }
    const scanned = filters.scan
      ? out.filter((record) => scanStateOf(record.state) === filters.scan)
      : out;
    return scanned
      .sort(
        (a, b) => (b.updatedAt ?? b.createdAt).getTime() - (a.updatedAt ?? a.createdAt).getTime(),
      )
      .slice(0, filters.limit);
  }

  private async fileVersionFacts(
    runner: TenantQueryRunner,
    context: TenantContext,
    fileIds: readonly string[],
  ): Promise<Map<string, { count: number; sizeBytes: number | null }>> {
    const facts = new Map<string, { count: number; sizeBytes: number | null; at: number }>();
    if (fileIds.length === 0) return new Map();
    const rows = await runner.query<QueryRows>(
      `select v.file_asset_id as file_asset_id, v.version_no as version_no, v.size_bytes as size_bytes
         from file_versions v
        where v.organization_id = ? and v.file_asset_id in (${fileIds.map(() => '?').join(', ')})`,
      [context.organizationId, ...fileIds],
    );
    for (const row of rows) {
      const id = String(row['file_asset_id']);
      const versionNo = num(row['version_no']) ?? 0;
      const current = facts.get(id);
      const count = (current?.count ?? 0) + 1;
      if (!current || versionNo >= current.at) {
        facts.set(id, { count, sizeBytes: num(row['size_bytes']), at: versionNo });
      } else {
        facts.set(id, { ...current, count });
      }
    }
    return new Map([...facts].map(([id, f]) => [id, { count: f.count, sizeBytes: f.sizeBytes }]));
  }

  // ── Requests ───────────────────────────────────────────────────────────────

  async listRequests(
    runner: TenantQueryRunner,
    context: TenantContext,
    filters: ListFilters,
  ): Promise<ContentRecord[]> {
    const org = context.organizationId;
    const params: SqlParameter[] = [org, org];
    let where = '';
    if (filters.q) {
      where += " and r.title like ? escape '\\\\'";
      params.push(likeContains(filters.q));
    }
    if (filters.projectId) {
      where += ' and r.project_id = ?';
      params.push(filters.projectId);
    }
    params.push(filters.limit);
    const rows = await runner.query<QueryRows>(
      `select r.id as id, r.title as title, r.description as description, r.state as state,
              r.project_id as project_id, p.name as project_name,
              r.submitted_by_user_id as author_user_id, u.display_name as author_name,
              r.created_at as created_at, r.updated_at as updated_at
         from client_requests r
         left join projects p on p.organization_id = ? and p.id = r.project_id
         left join users u on u.id = r.submitted_by_user_id
        where r.organization_id = ?${where}
        order by r.updated_at desc, r.id desc
        limit ?`,
      params,
    );
    return rows.map((row) => ({
      ...base(row, 'request_message'),
      kind: 'request_message' as const,
      title: String(row['title']),
      preview: previewOf(row['description']),
    }));
  }

  async listRequestMessages(
    runner: TenantQueryRunner,
    context: TenantContext,
    requestId: string,
    limit: number,
  ): Promise<ContentRecord[]> {
    const org = context.organizationId;
    const rows = await runner.query<QueryRows>(
      `select m.id as id, m.request_id as parent_id, m.body as body, m.author_kind as audience,
              am.user_id as author_user_id, u.display_name as author_name,
              m.created_at as created_at, ${DELETED_COLS('m')}
         from request_messages m
         left join memberships am on am.organization_id = ? and am.id = m.author_membership_id
         left join users u on u.id = am.user_id
        where m.organization_id = ? and m.request_id = ?
        order by m.created_at asc, m.id asc
        limit ?`,
      [org, org, requestId, limit],
    );
    return rows.map((row) => ({
      ...base(row, 'request_message'),
      title: String(row['author_name'] ?? ''),
      preview: text(row['body']),
    }));
  }

  // ── One row, any kind (the viewer, and the before-state of a write) ────────

  async findOne(
    runner: TenantQueryRunner,
    context: TenantContext,
    kind: ContentKind,
    id: string,
  ): Promise<
    (ContentRecord & { readonly body: string | null; readonly version: number | null }) | null
  > {
    const definition = CONTENT_KIND_DEFINITIONS[kind];
    const org = context.organizationId;
    const author = definition.authorColumn;
    const authorJoin =
      author === null
        ? ''
        : definition.authorIsMembership
          ? `left join memberships am on am.organization_id = ? and am.id = t.${author}
             left join users u on u.id = am.user_id`
          : `left join users u on u.id = t.${author}`;
    const authorSelect =
      author === null
        ? 'null as author_user_id, null as author_name'
        : definition.authorIsMembership
          ? 'am.user_id as author_user_id, u.display_name as author_name'
          : `t.${author} as author_user_id, u.display_name as author_name`;
    const extra = EXTRA_COLUMNS[kind];
    const params: SqlParameter[] = [];
    if (author !== null && definition.authorIsMembership) params.push(org);
    params.push(org, id);
    const rows = await runner.query<QueryRows>(
      `select t.id as id, t.${definition.titleColumn} as title_value, t.created_at as created_at,
              ${authorSelect}, ${extra}, ${DELETED_COLS('t')}
         from ${definition.table} t
         ${authorJoin}
        where t.organization_id = ? and t.id = ?
        limit 1`,
      params,
    );
    const row = rows[0];
    if (!row) return null;
    let projectName: string | null = null;
    const projectId = text(row['project_id']);
    if (projectId) {
      const projects = await runner.query<QueryRows>(
        'select p.name as name from projects p where p.organization_id = ? and p.id = ? limit 1',
        [org, projectId],
      );
      projectName = text(projects[0]?.['name']);
    }
    const title = String(row['title_value'] ?? '');
    return {
      ...base({ ...row, project_name: projectName }, kind),
      title: definition.titleColumn === 'body' ? (previewOf(title) ?? '') : title,
      preview: previewOf(row['body'] ?? row['title_value']),
      body: text(row['body'] ?? (definition.titleColumn === 'body' ? row['title_value'] : null)),
      version: num(row['version']),
      location:
        kind === 'file'
          ? 'local'
          : kind === 'drive_file'
            ? 'google_drive'
            : kind === 'onedrive_file'
              ? 'onedrive'
              : null,
      sizeBytes: num(row['size_bytes']),
    };
  }

  // ── Writes the organization modules have no statement for ──────────────────

  /** Soft delete: who, why, and the restore window (0245). False when already deleted. */
  async softDelete(
    runner: TenantQueryRunner,
    context: TenantContext,
    kind: ContentKind,
    id: string,
    reason: string | null,
  ): Promise<boolean> {
    const days = await contentPurgeDays(runner);
    const table = CONTENT_KIND_DEFINITIONS[kind].table;
    const result = await runner.execute<{ affectedRows?: number } & QueryRows>(
      `update ${table}
          set deleted_at = current_timestamp(3), deleted_by_user_id = ?, deleted_reason = ?,
              purge_after = date_add(current_timestamp(3), interval ? day)
        where organization_id = ? and id = ? and deleted_at is null`,
      [context.userId, normaliseDeletedReason(reason), days, context.organizationId, id],
    );
    return affected(result) > 0;
  }

  /** Restore: every soft-delete column back to NULL. False when the row was not deleted. */
  async restore(
    runner: TenantQueryRunner,
    context: TenantContext,
    kind: ContentKind,
    id: string,
  ): Promise<boolean> {
    const table = CONTENT_KIND_DEFINITIONS[kind].table;
    const result = await runner.execute<{ affectedRows?: number } & QueryRows>(
      `update ${table}
          set deleted_at = null, deleted_by_user_id = null, deleted_reason = null, purge_after = null
        where organization_id = ? and id = ? and deleted_at is not null`,
      [context.organizationId, id],
    );
    return affected(result) > 0;
  }

  // ── Trash (B7) ─────────────────────────────────────────────────────────────

  async trash(
    runner: TenantQueryRunner,
    context: TenantContext,
    filters: {
      readonly kinds: readonly ContentKind[];
      readonly actor: string | null;
      readonly q: string | null;
      readonly limit: number;
    },
  ): Promise<ContentRecord[]> {
    const out: ContentRecord[] = [];
    for (const kind of filters.kinds) {
      const definition = CONTENT_KIND_DEFINITIONS[kind];
      const params: SqlParameter[] = [context.organizationId];
      let where = '';
      if (filters.actor) {
        where += ' and t.deleted_by_user_id = ?';
        params.push(filters.actor);
      }
      if (filters.q) {
        where += ` and t.${definition.titleColumn} like ? escape '\\\\'`;
        params.push(likeContains(filters.q));
      }
      params.push(filters.limit);
      const rows = await runner.query<QueryRows>(
        `select t.id as id, t.${definition.titleColumn} as title_value, t.created_at as created_at,
                u.display_name as deleted_by_name, ${DELETED_COLS('t')}
           from ${definition.table} t
           left join users u on u.id = t.deleted_by_user_id
          where t.organization_id = ? and t.deleted_at is not null${where}
          order by t.deleted_at desc, t.id desc
          limit ?`,
        params,
      );
      for (const row of rows) {
        out.push({
          ...base(row, kind),
          title: previewOf(row['title_value']) ?? '',
          preview: null,
          authorName: text(row['deleted_by_name']),
        });
      }
    }
    return out
      .sort((a, b) => (b.deletedAt?.getTime() ?? 0) - (a.deletedAt?.getTime() ?? 0))
      .slice(0, filters.limit);
  }

  /** Of these objects, the ones whose latest delete was done inside a Support session. */
  async deletedBySupport(
    runner: TenantQueryRunner,
    context: TenantContext,
    objectIds: readonly string[],
  ): Promise<ReadonlySet<string>> {
    if (objectIds.length === 0) return new Set();
    const rows = await runner.query<QueryRows>(
      `select a.object_id as object_id from audit_events a
        where a.organization_id = ? and a.platform_support_session_id is not null
          and a.result = 'allowed' and a.action like '%.deleted'
          and a.object_id in (${objectIds.map(() => '?').join(', ')})`,
      [context.organizationId, ...objectIds],
    );
    return new Set(rows.map((row) => String(row['object_id'])));
  }

  // ── History (B6) ───────────────────────────────────────────────────────────

  async history(
    runner: TenantQueryRunner,
    context: TenantContext,
    objectId: string,
    limit = 20,
  ): Promise<HistoryRecord[]> {
    const org = context.organizationId;
    const rows = await runner.query<QueryRows>(
      `select a.id as id, a.action as action, a.result as result, a.created_at as created_at,
              a.actor_user_id as actor_user_id, u.display_name as actor_name,
              a.effective_actor_id as effective_actor_id,
              a.platform_support_session_id as platform_support_session_id,
              a.ip as ip, a.user_agent as user_agent
         from audit_events a
         left join users u on u.id = a.actor_user_id
        where a.organization_id = ? and a.object_id = ?
        order by a.created_at desc, a.id desc
        limit ?`,
      [org, objectId, limit],
    );
    if (rows.length === 0) return [];
    const ids = rows.map((row) => String(row['id']));
    const changes = await runner.query<QueryRows>(
      `select c.audit_event_id as audit_event_id, c.field as field, c.before_value as before_value,
              c.after_value as after_value, c.redacted as redacted
         from audit_event_changes c
        where c.organization_id = ? and c.audit_event_id in (${ids.map(() => '?').join(', ')})
        order by c.id asc`,
      [org, ...ids],
    );
    const byEvent = new Map<string, HistoryRecord['changes'][number][]>();
    for (const change of changes) {
      const key = String(change['audit_event_id']);
      const list = byEvent.get(key) ?? [];
      list.push({
        field: String(change['field']),
        before: text(change['before_value']),
        after: text(change['after_value']),
        redacted: Boolean(Number(change['redacted'] ?? 0)),
      });
      byEvent.set(key, list);
    }
    return rows.map((row) => ({
      id: String(row['id']),
      action: String(row['action']),
      result: String(row['result']),
      createdAt: date(row['created_at']) ?? new Date(0),
      actorUserId: text(row['actor_user_id']),
      actorName: text(row['actor_name']),
      effectiveActorId: text(row['effective_actor_id']),
      supportSessionId: text(row['platform_support_session_id']),
      ip: text(row['ip']),
      userAgent: text(row['user_agent']),
      changes: byEvent.get(String(row['id'])) ?? [],
    }));
  }

  // ── Deliverables (the locked-version rule, B6 436:20238) ───────────────────

  /** The deliverable versions a file backs, or every version of one deliverable. */
  async deliverableVersions(
    runner: TenantQueryRunner,
    context: TenantContext,
    by: { readonly fileAssetId: string } | { readonly deliverableId: string },
  ): Promise<DeliverableVersionRecord[]> {
    const org = context.organizationId;
    let deliverableId: string | null = 'deliverableId' in by ? by.deliverableId : null;
    if (deliverableId === null && 'fileAssetId' in by) {
      const owning = await runner.query<QueryRows>(
        `select v.deliverable_id as deliverable_id from deliverable_versions v
          where v.organization_id = ? and v.file_asset_id = ? limit 1`,
        [org, by.fileAssetId],
      );
      deliverableId = text(owning[0]?.['deliverable_id']);
    }
    if (deliverableId === null) return [];
    const versions = await runner.query<QueryRows>(
      `select v.id as id, v.deliverable_id as deliverable_id, d.title as title,
              v.version_no as version_no, v.file_asset_id as file_asset_id, f.name as file_name,
              v.created_at as created_at
         from deliverable_versions v
         join deliverables d on d.organization_id = ? and d.id = v.deliverable_id
         left join file_assets f on f.organization_id = ? and f.id = v.file_asset_id
        where v.organization_id = ? and v.deliverable_id = ?
        order by v.version_no desc`,
      [org, org, org, deliverableId],
    );
    if (versions.length === 0) return [];
    const approvals = await runner.query<QueryRows>(
      `select a.deliverable_version_id as version_id, a.state as state, a.decided_at as decided_at,
              a.updated_at as updated_at, u.display_name as decided_by_name
         from approvals a
         left join users u on u.id = a.decided_by_user_id
        where a.organization_id = ? and a.deliverable_id = ?
        order by a.updated_at asc`,
      [org, deliverableId],
    );
    const latest = new Map<string, Row>();
    for (const approval of approvals) latest.set(String(approval['version_id']), approval);
    return versions.map((row) => {
      const approval = latest.get(String(row['id']));
      return {
        id: String(row['id']),
        deliverableId: String(row['deliverable_id']),
        deliverableTitle: String(row['title'] ?? ''),
        versionNo: num(row['version_no']) ?? 0,
        fileAssetId: text(row['file_asset_id']),
        fileName: text(row['file_name']),
        createdAt: date(row['created_at']) ?? new Date(0),
        approvalState: approval ? text(approval['state']) : null,
        approvedAt: approval ? date(approval['decided_at']) : null,
        approvedByName: approval ? text(approval['decided_by_name']) : null,
      };
    });
  }
}

/** The columns `findOne` reads beyond the common ones, per kind. */
const EXTRA_COLUMNS: Readonly<Record<ContentKind, string>> = {
  message: `t.conversation_id as parent_id, t.body as body, t.sequence_no as sequence_no,
            t.edited_at as edited_at, t.updated_at as updated_at, null as project_id,
            null as state, null as audience, null as version, null as size_bytes, null as due_at`,
  direct_message: `t.direct_conversation_id as parent_id, t.body as body, t.sequence_no as sequence_no,
            null as edited_at, null as updated_at, null as project_id, null as state,
            null as audience, null as version, null as size_bytes, null as due_at`,
  work_item: `null as parent_id, t.description as body, null as sequence_no, null as edited_at,
            t.updated_at as updated_at, t.project_id as project_id, t.state as state,
            t.audience as audience, t.version as version, null as size_bytes, t.due_at as due_at`,
  work_comment: commentExtra('work_item_id'),
  doc_comment: commentExtra('document_id'),
  decision_comment: commentExtra('decision_id'),
  file_comment: commentExtra('file_asset_id'),
  request_comment: commentExtra('request_id'),
  update_comment: commentExtra('update_id'),
  doc: `null as parent_id, t.body as body, null as sequence_no, null as edited_at,
            t.updated_at as updated_at, t.project_id as project_id,
            case when t.published_at is null then 'draft' else 'published' end as state,
            t.audience as audience, null as version, null as size_bytes, null as due_at`,
  decision: `null as parent_id, t.statement as body, null as sequence_no, null as edited_at,
            t.decided_at as updated_at, t.project_id as project_id, t.status as state,
            t.audience as audience, null as version, null as size_bytes, null as due_at,
            t.rationale as rationale`,
  meeting: `null as parent_id, t.agenda_note as body, null as sequence_no, null as edited_at,
            t.updated_at as updated_at, t.project_id as project_id,
            case when t.cancelled_at is null then 'scheduled' else 'cancelled' end as state,
            t.visibility as audience, null as version, null as size_bytes, t.starts_at as due_at`,
  file: `null as parent_id, null as body, null as sequence_no, null as edited_at,
            t.updated_at as updated_at, t.project_id as project_id, t.status as state,
            t.audience as audience, t.version as version, null as size_bytes, null as due_at`,
  drive_file: attachmentExtra(),
  onedrive_file: attachmentExtra(),
  request_message: `t.request_id as parent_id, t.body as body, null as sequence_no, null as edited_at,
            null as updated_at, null as project_id, null as state, t.author_kind as audience,
            null as version, null as size_bytes, null as due_at`,
};

function commentExtra(objectColumn: string): string {
  return `t.${objectColumn} as parent_id, t.body as body, null as sequence_no, null as edited_at,
            null as updated_at, null as project_id, null as state, null as audience,
            null as version, null as size_bytes, null as due_at`;
}

function attachmentExtra(): string {
  return `t.work_item_id as parent_id, null as body, null as sequence_no, null as edited_at,
            null as updated_at, null as project_id, 'linked' as state, null as audience,
            null as version, t.size_bytes as size_bytes, null as due_at`;
}

function affected(result: unknown): number {
  const value = (result as { affectedRows?: unknown } | null)?.affectedRows;
  return typeof value === 'number' ? value : 0;
}

/** `file_assets.status` → the scan column of the Files table (436:17136). */
export function scanStateOf(
  status: string | null,
): 'clean' | 'scanning' | 'blocked' | 'linked' | 'pending' {
  switch (status) {
    case 'ready':
      return 'clean';
    case 'uploaded':
    case 'verifying':
    case 'scanning':
      return 'scanning';
    case 'rejected':
      return 'blocked';
    case 'linked':
      return 'linked';
    default:
      return 'pending';
  }
}
