import type { RowDataPacket } from 'mysql2';
import type {
  BootstrapQueryRunner,
  SqlParameter,
  TenantContext,
  TenantQueryRunner,
} from '../../common/database/tenant-context.js';
import type { SupportAuthorKind, SupportStatus } from './support.policy.js';
import { isSupportStatus } from './support.policy.js';
import { SUPPORT_CATEGORIES, SUPPORT_PRIORITIES } from './support-sla.js';
import type { SupportCategory, SupportPriority } from './support-sla.js';

/**
 * 55-17 — the one file holding SQL for `support_threads` / `support_messages` (0324, TENANT).
 *
 * Member reads and writes take the caller's own `TenantQueryRunner` and bind
 * `organization_id = context.organizationId` in every statement. The one cross-organization read
 * is {@link SupportRepository.listAcrossOrganizations}, which only runs on the platform-admin
 * bootstrap path (a declared table list and a recorded reason) — see `support.service.ts`.
 */

export const MAX_LISTED_THREADS = 200;
export const MAX_THREAD_MESSAGES = 500;

type Row = RowDataPacket & Record<string, unknown>;

export interface SupportThreadRecord {
  readonly id: string;
  readonly organizationId: string;
  readonly organizationSlug: string | null;
  readonly organizationName: string | null;
  readonly startedByUserId: string;
  readonly startedByName: string | null;
  readonly startedByEmail: string | null;
  readonly subject: string;
  readonly status: SupportStatus;
  readonly contextPath: string | null;
  readonly contextAppVersion: string | null;
  readonly messageCount: number;
  readonly lastMessageAt: Date;
  readonly lastAuthorKind: SupportAuthorKind;
  readonly createdAt: Date;
  readonly closedAt: Date | null;
  // 0352 (57-10)
  readonly category: SupportCategory;
  readonly priority: SupportPriority;
  readonly planIdAtOpen: string | null;
  readonly slaTimezone: string | null;
  readonly slaFirstResponseMinutes: number | null;
  readonly slaResolutionMinutes: number | null;
  readonly firstResponseAt: Date | null;
  readonly slaPausedAt: Date | null;
  readonly slaPausedMinutes: number;
  readonly slaBreached: boolean;
}

/** 57-10. The SLA captured when a thread is opened. */
export interface NewSupportSla {
  readonly category: SupportCategory;
  readonly priority: SupportPriority;
  readonly planIdAtOpen: string;
  readonly timezone: string;
  readonly firstResponseMinutes: number;
  readonly resolutionMinutes: number;
}

/** 57-10. The SLA columns a write moves (status change, reply). */
export interface SupportSlaUpdate {
  readonly firstResponseAt: Date | null;
  readonly pausedAt: Date | null;
  readonly pausedMinutes: number;
  readonly breached: boolean;
}

export interface SupportMessageRecord {
  readonly id: string;
  readonly threadId: string;
  readonly authorKind: SupportAuthorKind;
  readonly authorUserId: string;
  readonly authorName: string | null;
  readonly body: string;
  readonly attachmentFileId: string | null;
  readonly attachmentName: string | null;
  readonly createdAt: Date;
}

export interface NewSupportThread {
  readonly id: string;
  readonly startedByUserId: string;
  readonly subject: string;
  readonly contextPath: string | null;
  readonly contextAppVersion: string | null;
  readonly sla: NewSupportSla;
  readonly at: Date;
}

export interface NewSupportMessage {
  readonly id: string;
  readonly threadId: string;
  readonly authorKind: SupportAuthorKind;
  readonly authorUserId: string;
  readonly body: string;
  readonly attachmentFileId: string | null;
  readonly attachmentName: string | null;
  readonly at: Date;
}

const THREAD_COLUMNS = `t.id as id, t.organization_id as organization_id,
  t.started_by_user_id as started_by_user_id, t.subject as subject, t.status as status,
  t.context_path as context_path, t.context_app_version as context_app_version,
  t.message_count as message_count, t.last_message_at as last_message_at,
  t.last_author_kind as last_author_kind, t.created_at as created_at, t.closed_at as closed_at,
  u.display_name as started_by_name, u.email as started_by_email,
  t.category as category, t.priority as priority, t.plan_id_at_open as plan_id_at_open,
  t.sla_timezone as sla_timezone, t.sla_first_response_minutes as sla_first_response_minutes,
  t.sla_resolution_minutes as sla_resolution_minutes, t.first_response_at as first_response_at,
  t.sla_paused_at as sla_paused_at, t.sla_paused_minutes as sla_paused_minutes,
  t.sla_breached as sla_breached`;

export const SUPPORT_SQL = {
  insertThread: `insert into support_threads
      (id, organization_id, started_by_user_id, subject, status, context_path, context_app_version,
       message_count, last_message_at, last_author_kind, created_at, updated_at, closed_at,
       category, priority, plan_id_at_open, sla_timezone, sla_first_response_minutes,
       sla_resolution_minutes)
    values (?, ?, ?, ?, 'open', ?, ?, 0, ?, 'member', ?, ?, null, ?, ?, ?, ?, ?, ?)`,
  /** 57-10. Moves the SLA columns; never touched by a member-supplied value. */
  updateSla: `update support_threads t
    set t.first_response_at = ?, t.sla_paused_at = ?, t.sla_paused_minutes = ?, t.sla_breached = ?
    where t.organization_id = ? and t.id = ?`,
  /** 57-10. The plan and timezone the SLA is captured from at opening. */
  slaTimezone: `select o.timezone as timezone from organizations o where o.id = ? limit 1`,
  slaPlan: `select s.plan_id as plan_id from subscriptions s where s.organization_id = ? limit 1`,
  insertMessage: `insert into support_messages
      (id, organization_id, thread_id, author_kind, author_user_id, body, attachment_file_id,
       attachment_name, created_at)
    values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  touchThread: `update support_threads t
    set t.message_count = t.message_count + 1, t.last_message_at = ?, t.last_author_kind = ?,
      t.status = ?, t.closed_at = ?, t.updated_at = ?
    where t.organization_id = ? and t.id = ?`,
  setStatus: `update support_threads t set t.status = ?, t.closed_at = ?, t.updated_at = ?
    where t.organization_id = ? and t.id = ?`,
  listForOrg: `select ${THREAD_COLUMNS} from support_threads t
    left join users u on u.id = t.started_by_user_id
    where t.organization_id = ?
    order by t.last_message_at desc limit ${MAX_LISTED_THREADS}`,
  listForStarter: `select ${THREAD_COLUMNS} from support_threads t
    left join users u on u.id = t.started_by_user_id
    where t.organization_id = ? and t.started_by_user_id = ?
    order by t.last_message_at desc limit ${MAX_LISTED_THREADS}`,
  byId: `select ${THREAD_COLUMNS} from support_threads t
    left join users u on u.id = t.started_by_user_id
    where t.organization_id = ? and t.id = ? limit 1`,
  byIdForUpdate: `select ${THREAD_COLUMNS} from support_threads t
    left join users u on u.id = t.started_by_user_id
    where t.organization_id = ? and t.id = ? limit 1 for update`,
  messages: `select m.id as id, m.thread_id as thread_id, m.author_kind as author_kind,
      m.author_user_id as author_user_id, m.body as body,
      m.attachment_file_id as attachment_file_id, m.attachment_name as attachment_name,
      m.created_at as created_at, u.display_name as author_name
    from support_messages m
    left join users u on u.id = m.author_user_id
    where m.organization_id = ? and m.thread_id = ?
    order by m.created_at asc, m.id asc limit ${MAX_THREAD_MESSAGES}`,
  /** Platform only, on the bootstrap path: every organization's threads, newest activity first. */
  listAcross: `select ${THREAD_COLUMNS}, o.slug as organization_slug, o.name as organization_name
    from support_threads t
    join organizations o on o.id = t.organization_id
    left join users u on u.id = t.started_by_user_id
    order by t.last_message_at desc limit ${MAX_LISTED_THREADS}`,
  orgOfThread: `select t.organization_id as organization_id from support_threads t
    where t.id = ? limit 1`,
  organizationLabel: `select o.slug as slug, o.name as name from organizations o
    where o.id = ? limit 1`,
} as const;

function date(value: unknown): Date | null {
  if (value === null || value === undefined) return null;
  const parsed = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function text(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

function authorKind(value: unknown): SupportAuthorKind {
  return value === 'platform' ? 'platform' : 'member';
}

export function toThreadRecord(row: Row): SupportThreadRecord {
  const status = String(row['status']);
  return {
    id: String(row['id']),
    organizationId: String(row['organization_id']),
    organizationSlug: text(row['organization_slug']),
    organizationName: text(row['organization_name']),
    startedByUserId: String(row['started_by_user_id']),
    startedByName: text(row['started_by_name']),
    startedByEmail: text(row['started_by_email']),
    subject: String(row['subject'] ?? ''),
    status: isSupportStatus(status) ? status : 'open',
    contextPath: text(row['context_path']),
    contextAppVersion: text(row['context_app_version']),
    messageCount: Number(row['message_count'] ?? 0),
    lastMessageAt: date(row['last_message_at']) ?? new Date(0),
    lastAuthorKind: authorKind(row['last_author_kind']),
    createdAt: date(row['created_at']) ?? new Date(0),
    closedAt: date(row['closed_at']),
    category: oneOf(row['category'], SUPPORT_CATEGORIES, 'question'),
    priority: oneOf(row['priority'], SUPPORT_PRIORITIES, 'normal'),
    planIdAtOpen: text(row['plan_id_at_open']),
    slaTimezone: text(row['sla_timezone']),
    slaFirstResponseMinutes: count(row['sla_first_response_minutes']),
    slaResolutionMinutes: count(row['sla_resolution_minutes']),
    firstResponseAt: date(row['first_response_at']),
    slaPausedAt: date(row['sla_paused_at']),
    slaPausedMinutes: count(row['sla_paused_minutes']) ?? 0,
    slaBreached: Number(row['sla_breached'] ?? 0) === 1,
  };
}

function oneOf<T extends string>(value: unknown, values: readonly T[], fallback: T): T {
  return (values as readonly unknown[]).includes(value) ? (value as T) : fallback;
}

function count(value: unknown): number | null {
  return value === null || value === undefined ? null : Number(value);
}

export function toMessageRecord(row: Row): SupportMessageRecord {
  return {
    id: String(row['id']),
    threadId: String(row['thread_id']),
    authorKind: authorKind(row['author_kind']),
    authorUserId: String(row['author_user_id']),
    authorName: text(row['author_name']),
    body: String(row['body'] ?? ''),
    attachmentFileId: text(row['attachment_file_id']),
    attachmentName: text(row['attachment_name']),
    createdAt: date(row['created_at']) ?? new Date(0),
  };
}

export class SupportRepository {
  async insertThread(
    runner: TenantQueryRunner,
    context: TenantContext,
    thread: NewSupportThread,
  ): Promise<void> {
    const params: SqlParameter[] = [
      thread.id,
      context.organizationId,
      thread.startedByUserId,
      thread.subject,
      thread.contextPath,
      thread.contextAppVersion,
      thread.at,
      thread.at,
      thread.at,
      thread.sla.category,
      thread.sla.priority,
      thread.sla.planIdAtOpen,
      thread.sla.timezone,
      thread.sla.firstResponseMinutes,
      thread.sla.resolutionMinutes,
    ];
    await runner.query(SUPPORT_SQL.insertThread, params);
  }

  async updateSla(
    runner: TenantQueryRunner,
    context: TenantContext,
    threadId: string,
    sla: SupportSlaUpdate,
  ): Promise<void> {
    await runner.query(SUPPORT_SQL.updateSla, [
      sla.firstResponseAt,
      sla.pausedAt,
      sla.pausedMinutes,
      sla.breached ? 1 : 0,
      context.organizationId,
      threadId,
    ]);
  }

  /** The organization's plan id (null without a subscription row) and timezone. */
  async slaSource(
    runner: TenantQueryRunner,
    context: TenantContext,
  ): Promise<{ planId: string | null; timezone: string | null }> {
    const [zone] = await runner.query<Row[]>(SUPPORT_SQL.slaTimezone, [context.organizationId]);
    const [plan] = await runner.query<Row[]>(SUPPORT_SQL.slaPlan, [context.organizationId]);
    return { planId: text(plan?.['plan_id']), timezone: text(zone?.['timezone']) };
  }

  /** Append one message and move the thread's counters and status in the same unit of work. */
  async appendMessage(
    runner: TenantQueryRunner,
    context: TenantContext,
    message: NewSupportMessage,
    nextStatus: SupportStatus,
  ): Promise<void> {
    await runner.query(SUPPORT_SQL.insertMessage, [
      message.id,
      context.organizationId,
      message.threadId,
      message.authorKind,
      message.authorUserId,
      message.body,
      message.attachmentFileId,
      message.attachmentName,
      message.at,
    ]);
    await runner.query(SUPPORT_SQL.touchThread, [
      message.at,
      message.authorKind,
      nextStatus,
      nextStatus === 'closed' ? message.at : null,
      message.at,
      context.organizationId,
      message.threadId,
    ]);
  }

  async setStatus(
    runner: TenantQueryRunner,
    context: TenantContext,
    threadId: string,
    status: SupportStatus,
    at: Date,
  ): Promise<void> {
    await runner.query(SUPPORT_SQL.setStatus, [
      status,
      status === 'closed' ? at : null,
      at,
      context.organizationId,
      threadId,
    ]);
  }

  async list(
    runner: TenantQueryRunner,
    context: TenantContext,
    startedBy: string | null,
  ): Promise<readonly SupportThreadRecord[]> {
    const rows =
      startedBy === null
        ? await runner.query<Row[]>(SUPPORT_SQL.listForOrg, [context.organizationId])
        : await runner.query<Row[]>(SUPPORT_SQL.listForStarter, [
            context.organizationId,
            startedBy,
          ]);
    return rows.map(toThreadRecord);
  }

  async find(
    runner: TenantQueryRunner,
    context: TenantContext,
    threadId: string,
    forUpdate = false,
  ): Promise<SupportThreadRecord | null> {
    const [row] = await runner.query<Row[]>(
      forUpdate ? SUPPORT_SQL.byIdForUpdate : SUPPORT_SQL.byId,
      [context.organizationId, threadId],
    );
    return row ? toThreadRecord(row) : null;
  }

  async messages(
    runner: TenantQueryRunner,
    context: TenantContext,
    threadId: string,
  ): Promise<readonly SupportMessageRecord[]> {
    const rows = await runner.query<Row[]>(SUPPORT_SQL.messages, [
      context.organizationId,
      threadId,
    ]);
    return rows.map(toMessageRecord);
  }

  async organizationLabel(
    runner: TenantQueryRunner,
    context: TenantContext,
  ): Promise<{ slug: string; name: string } | null> {
    const [row] = await runner.query<Row[]>(SUPPORT_SQL.organizationLabel, [
      context.organizationId,
    ]);
    return row ? { slug: String(row['slug']), name: String(row['name']) } : null;
  }

  /** Platform bootstrap path only. */
  async listAcrossOrganizations(
    runner: BootstrapQueryRunner,
  ): Promise<readonly SupportThreadRecord[]> {
    return (await runner.query<Row[]>(SUPPORT_SQL.listAcross)).map(toThreadRecord);
  }

  /** Platform bootstrap path only: which organization owns this thread (for the service context). */
  async organizationOfThread(
    runner: BootstrapQueryRunner,
    threadId: string,
  ): Promise<string | null> {
    const [row] = await runner.query<Row[]>(SUPPORT_SQL.orgOfThread, [threadId]);
    return row ? String(row['organization_id']) : null;
  }
}
