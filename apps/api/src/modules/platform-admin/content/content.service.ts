import { isWorkItemState } from '@tmanage/domain';
import type { AuditAction, AuditMetadata, Principal } from '@tmanage/domain';
import type {
  TenantContext,
  TenantDatabase,
  TenantQueryRunner,
} from '../../../common/database/tenant-context.js';
import { contentPurgeDays } from '../../../common/database/content-retention.js';
import { ApiError, MESSAGES } from '../../../common/http/errors.js';
import type { AuditChangeInput } from '../../audit/audit-redaction.js';
import type { AuditService } from '../../audit/audit.service.js';
import type { FileDownload } from '../../files/file-download.service.js';
import { optionalReason, requireReason } from '../platform-admin.access.js';
import type { PlatformAdminActor } from '../platform-admin.guard.js';
import type { PlatformAuditService } from '../platform-audit.service.js';
import {
  CONTENT_KIND_DEFINITIONS,
  EDITABLE_KINDS,
  TRASH_KINDS,
  commentKindOf,
  isContentKind,
} from './content-kinds.js';
import type { ContentArea, ContentKind } from './content-kinds.js';
import { scanStateOf } from './content-lists.repository.js';
import type {
  ContentListsRepository,
  ContentRecord,
  DeletedFilter,
  DeliverableVersionRecord,
  HistoryRecord,
} from './content-lists.repository.js';
import type { SupportContextResolver, SupportRequest, SupportScope } from './support-context.js';

/**
 * platform-admin v2 · PA-08 — the content browser, viewer/moderation panel and trash (B5–B7,
 * SPEC §5.4).
 *
 * Every call first resolves the Support scope (428 without a live session), then:
 * - **reads** run the browser's list queries on that one-organization context;
 * - **edits** go through the organization's own services where one exists for the change (work
 *   items, documents, decisions, meetings — so their lifecycle rules refuse what they refuse), and
 *   through the module's repository for a message (the members' service lets only the author
 *   edit; support is the one other writer, and the row's engine-written revision keeps the old
 *   text). Each edit then records the module's audit action with `changes[]` (before/after) —
 *   the support stamp makes `effective_actor_id` the admin;
 * - **deletes** are soft (0245): who, the REQUIRED reason, `purge_after`; **restores** clear them;
 * - a version an approval locked, and an append-only row's text, are refused with an explanation
 *   — never bypassed.
 * Every write also lands in the platform's own log (`platform.content_*`).
 */

// ── Views (paired in e2e/contracts/api-web-shapes.ts) ─────────────────────────

export interface PlatformContentOrgView {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
}

export interface PlatformContentSessionView {
  readonly id: string;
  readonly adminEmail: string;
  readonly expiresAt: string;
}

export interface PlatformContentCountsView {
  readonly chats: number;
  readonly dms: number;
  readonly workItems: number;
  readonly comments: number;
  readonly docs: number;
  readonly decisions: number;
  readonly meetings: number;
  readonly files: number;
  readonly requests: number;
}

export interface PlatformContentHomeView {
  readonly organization: PlatformContentOrgView;
  readonly session: PlatformContentSessionView;
  readonly counts: PlatformContentCountsView;
  readonly trashCount: number;
}

export interface PlatformContentRowView {
  readonly kind: string;
  readonly id: string;
  readonly parentId: string | null;
  readonly title: string;
  readonly preview: string | null;
  readonly projectId: string | null;
  readonly projectName: string | null;
  readonly authorUserId: string | null;
  readonly authorName: string | null;
  readonly createdAt: string;
  readonly updatedAt: string | null;
  readonly deletedAt: string | null;
  readonly deletedReason: string | null;
  readonly purgeAfter: string | null;
  readonly deletedViaSupport: boolean;
  readonly state: string | null;
  readonly scan: string | null;
  readonly audience: string | null;
  readonly location: string | null;
  readonly sizeBytes: number | null;
  readonly versions: number | null;
  readonly edited: boolean;
  readonly replies: number | null;
  readonly dueAt: string | null;
  readonly sequenceNo: number | null;
}

export interface PlatformContentListView {
  readonly area: string;
  readonly rows: readonly PlatformContentRowView[];
}

export interface PlatformContentMessagesView {
  readonly conversationId: string;
  readonly kind: string;
  readonly messages: readonly PlatformContentRowView[];
}

export interface PlatformContentChangeView {
  readonly field: string;
  readonly before: string | null;
  readonly after: string | null;
  readonly redacted: boolean;
}

export interface PlatformContentHistoryView {
  readonly id: string;
  readonly action: string;
  readonly result: string;
  readonly at: string;
  readonly actorName: string | null;
  readonly viaSupport: boolean;
  readonly supportSessionId: string | null;
  readonly userAgent: string | null;
  readonly changes: readonly PlatformContentChangeView[];
}

export interface PlatformContentLockView {
  /** `version_locked` (approved deliverable version) or `append_only` (said words stay said). */
  readonly code: string;
  readonly approvedAt: string | null;
  readonly approvedByName: string | null;
}

export interface PlatformContentVersionView {
  readonly id: string;
  readonly deliverableId: string;
  readonly deliverableTitle: string;
  readonly versionNo: number;
  readonly fileAssetId: string | null;
  readonly fileName: string | null;
  readonly approvalState: string | null;
  readonly approvedAt: string | null;
  readonly approvedByName: string | null;
  readonly createdAt: string;
}

export interface PlatformContentItemView {
  readonly organization: PlatformContentOrgView;
  readonly item: PlatformContentRowView;
  readonly body: string | null;
  readonly version: number | null;
  readonly editable: readonly string[];
  readonly locked: PlatformContentLockView | null;
  readonly history: readonly PlatformContentHistoryView[];
  readonly deliverableVersions: readonly PlatformContentVersionView[];
  readonly openInApp: string | null;
}

export interface PlatformContentTrashView {
  readonly rows: readonly PlatformContentRowView[];
  readonly purgeDays: number;
}

export interface PlatformContentWriteView {
  readonly item: PlatformContentRowView;
}

// ── Ports onto the organization modules (constructed by the module; faked in tests) ──────────

export interface ContentOrgPorts {
  readonly messages: {
    editMessage(
      runner: TenantQueryRunner,
      context: TenantContext,
      messageId: string,
      body: string,
      bodyRich: null,
    ): Promise<unknown>;
    moderateMessage(
      runner: TenantQueryRunner,
      context: TenantContext,
      messageId: string,
      deletedByUserId: string,
      reason: string | null,
    ): Promise<unknown>;
  };
  readonly workItemsRepository: {
    softDelete(
      runner: TenantQueryRunner,
      context: TenantContext,
      workItemId: string,
      reason: string | null,
    ): Promise<unknown>;
  };
  readonly workItems: {
    update(
      context: TenantContext,
      principal: Principal,
      workItemId: string,
      expectedVersion: number,
      input: {
        readonly title?: string;
        readonly description?: string | null;
        readonly ownerUserId?: string | null;
        readonly dueAt?: Date | null;
      },
    ): Promise<{ readonly version: number }>;
    transition(
      context: TenantContext,
      principal: Principal,
      workItemId: string,
      expectedVersion: number,
      to: never,
    ): Promise<unknown>;
  };
  readonly documents: {
    rename(
      context: TenantContext,
      principal: Principal,
      documentId: string,
      input: { readonly title: string; readonly expectedUpdatedAt: string },
    ): Promise<unknown>;
  };
  readonly decisions: {
    updateDetails(
      context: TenantContext,
      principal: Principal,
      decisionId: string,
      input: { readonly rationale?: string | null },
    ): Promise<unknown>;
  };
  readonly meetings: {
    update(
      context: TenantContext,
      principal: Principal,
      meetingId: string,
      input: { readonly title?: string; readonly agendaNote?: string | null },
    ): Promise<unknown>;
  };
  readonly downloads: {
    download(
      context: TenantContext,
      principal: Principal,
      fileAssetId: string,
    ): Promise<FileDownload>;
  };
}

export interface ContentQuery {
  readonly [key: string]: unknown;
}

export interface EditBody {
  readonly body?: unknown;
  readonly title?: unknown;
  readonly description?: unknown;
  readonly dueAt?: unknown;
  readonly ownerUserId?: unknown;
  readonly state?: unknown;
  readonly rationale?: unknown;
  readonly agendaNote?: unknown;
  readonly reason?: unknown;
}

const MAX_BODY = 16_000;
const MAX_TITLE = 300;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

/** What a support admin may change, per kind (the B6 editor's fields). */
const EDITABLE_FIELDS: Readonly<Partial<Record<ContentKind, readonly string[]>>> = {
  message: ['body'],
  work_item: ['title', 'description', 'state', 'ownerUserId', 'dueAt'],
  doc: ['title'],
  decision: ['rationale'],
  meeting: ['title', 'agendaNote'],
};

export const VERSION_LOCKED_MESSAGE =
  'This version is approved, so it is locked — editing and deleting are refused for everyone, ' +
  'support included. To change it, add a new version in the app; the approval history stays intact.';

export const APPEND_ONLY_MESSAGE =
  'What was posted here cannot be rewritten by anyone, support included. Delete it instead; it ' +
  'can be restored from Deleted content until it is purged.';

function iso(value: Date | null): string | null {
  return value === null ? null : value.toISOString();
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

function limitOf(raw: unknown): number {
  const parsed = typeof raw === 'string' ? Number(raw) : typeof raw === 'number' ? raw : NaN;
  if (!Number.isSafeInteger(parsed) || parsed < 1) return DEFAULT_LIMIT;
  return Math.min(parsed, MAX_LIMIT);
}

function deletedOf(raw: unknown): DeletedFilter {
  if (raw === 'only' || raw === 'true' || raw === '1') return 'only';
  if (raw === 'exclude' || raw === 'false' || raw === '0') return 'exclude';
  return 'include';
}

function sequenceOf(raw: unknown, field: string): number | null {
  if (raw === undefined || raw === null || raw === '') return null;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new ApiError(400, 'validation_failed', 'The query is invalid', [
      { field, message: 'must be a non-negative integer' },
    ]);
  }
  return parsed;
}

function notFound(): ApiError {
  return new ApiError(404, 'not_found', MESSAGES.notFound);
}

function invalid(field: string, message: string): ApiError {
  return new ApiError(400, 'validation_failed', 'The request body is invalid', [
    { field, message },
  ]);
}

export function toRowView(
  record: ContentRecord,
  viaSupport: ReadonlySet<string>,
): PlatformContentRowView {
  const fileKind =
    record.kind === 'file' || record.kind === 'drive_file' || record.kind === 'onedrive_file';
  return {
    kind: record.kind,
    id: record.id,
    parentId: record.parentId,
    title: record.title,
    preview: record.deletedAt !== null && record.kind !== 'file' ? null : record.preview,
    projectId: record.projectId,
    projectName: record.projectName,
    authorUserId: record.authorUserId,
    authorName: record.authorName,
    createdAt: record.createdAt.toISOString(),
    updatedAt: iso(record.updatedAt),
    deletedAt: iso(record.deletedAt),
    deletedReason: record.deletedReason,
    purgeAfter: iso(record.purgeAfter),
    deletedViaSupport: record.deletedAt !== null && viaSupport.has(record.id),
    state: record.state,
    scan: fileKind ? (record.deletedAt !== null ? 'deleted' : scanStateOf(record.state)) : null,
    audience: record.audience,
    location: record.location,
    sizeBytes: record.sizeBytes,
    versions: record.versions,
    edited: record.edited,
    replies: record.replies,
    dueAt: iso(record.dueAt),
    sequenceNo: record.sequenceNo,
  };
}

function historyView(record: HistoryRecord): PlatformContentHistoryView {
  return {
    id: record.id,
    action: record.action,
    result: record.result,
    at: record.createdAt.toISOString(),
    actorName: record.actorName,
    viaSupport: record.supportSessionId !== null,
    supportSessionId: record.supportSessionId,
    userAgent: record.userAgent,
    changes: record.changes.map((change) => ({ ...change })),
  };
}

function versionView(record: DeliverableVersionRecord): PlatformContentVersionView {
  return {
    id: record.id,
    deliverableId: record.deliverableId,
    deliverableTitle: record.deliverableTitle,
    versionNo: record.versionNo,
    fileAssetId: record.fileAssetId,
    fileName: record.fileName,
    approvalState: record.approvalState,
    approvedAt: iso(record.approvedAt),
    approvedByName: record.approvedByName,
    createdAt: record.createdAt.toISOString(),
  };
}

/** "Open in app" — continues in Support mode inside the organization (`/{slug}/…`). */
export function openInAppPath(slug: string, record: ContentRecord): string | null {
  const s = encodeURIComponent(slug);
  switch (record.kind) {
    case 'message':
      return record.parentId ? `/${s}/chat/${record.parentId}` : `/${s}/chat`;
    case 'direct_message':
      return `/${s}/chat/dm`;
    case 'work_item':
      return `/${s}/work/${record.id}`;
    case 'work_comment':
    case 'drive_file':
    case 'onedrive_file':
      return record.parentId ? `/${s}/work/${record.parentId}` : `/${s}/work`;
    case 'doc':
      return `/${s}/docs/${record.id}`;
    case 'doc_comment':
      return record.parentId ? `/${s}/docs/${record.parentId}` : `/${s}/docs`;
    case 'decision':
      return `/${s}/decisions/${record.id}`;
    case 'decision_comment':
      return record.parentId ? `/${s}/decisions/${record.parentId}` : `/${s}/decisions`;
    case 'meeting':
      return `/${s}/calendar`;
    case 'file':
    case 'file_comment':
      return record.projectId ? `/${s}/projects/${record.projectId}` : `/${s}/projects`;
    case 'request_message':
    case 'request_comment':
      return `/${s}/work/requests`;
    case 'update_comment':
      return `/${s}/projects`;
    default:
      return null;
  }
}

export class PlatformContentService {
  constructor(
    private readonly database: TenantDatabase,
    private readonly support: Pick<SupportContextResolver, 'resolve'>,
    private readonly lists: ContentListsRepository,
    private readonly audit: Pick<AuditService, 'record' | 'recordStandalone'>,
    private readonly platformAudit: Pick<PlatformAuditService, 'record'>,
    private readonly org: ContentOrgPorts,
  ) {}

  // ── B5 ────────────────────────────────────────────────────────────────────

  async home(
    actor: PlatformAdminActor,
    organizationId: string,
    request: SupportRequest,
  ): Promise<PlatformContentHomeView> {
    const scope = await this.support.resolve(actor, organizationId, request);
    return this.database.read(scope.context, async (runner) => {
      const organization = await this.organizationOf(runner, scope);
      const counts = await this.lists.counts(runner, scope.context);
      return {
        organization,
        session: {
          id: scope.session.id,
          adminEmail: actor.account.email,
          expiresAt: scope.session.expiresAt.toISOString(),
        },
        counts: {
          chats: counts.chats,
          dms: counts.dms,
          workItems: counts.work_items,
          comments: counts.comments,
          docs: counts.docs,
          decisions: counts.decisions,
          meetings: counts.meetings,
          files: counts.files,
          requests: counts.requests,
        },
        trashCount: await this.lists.trashCount(runner, scope.context),
      };
    });
  }

  async list(
    actor: PlatformAdminActor,
    organizationId: string,
    area: ContentArea,
    query: ContentQuery,
    request: SupportRequest,
  ): Promise<PlatformContentListView> {
    const scope = await this.support.resolve(actor, organizationId, request);
    const filters = {
      q: str(query['q']),
      projectId: str(query['projectId']),
      deleted: deletedOf(query['deleted']),
      limit: limitOf(query['limit']),
    };
    return this.database.read(scope.context, async (runner) => {
      const ctx = scope.context;
      let records: ContentRecord[];
      switch (area) {
        case 'chats':
          records = await this.lists.listChannels(runner, ctx, filters);
          break;
        case 'dms':
          records = await this.lists.listDirectConversations(runner, ctx, filters);
          break;
        case 'work_items':
          records = await this.lists.listWorkItems(runner, ctx, {
            ...filters,
            state: str(query['state']),
            assignee: str(query['assignee']),
          });
          break;
        case 'comments': {
          const objectType = query['objectType'];
          const kind = objectType === undefined ? null : commentKindOf(objectType);
          if (objectType !== undefined && kind === null) {
            throw new ApiError(400, 'validation_failed', 'The query is invalid', [
              { field: 'objectType', message: 'work, doc, decision, file, request or update' },
            ]);
          }
          records = await this.lists.listComments(runner, ctx, {
            ...filters,
            kind,
            objectId: str(query['objectId']),
            author: str(query['author']),
          });
          break;
        }
        case 'docs':
          records = await this.lists.listDocs(runner, ctx, filters);
          break;
        case 'decisions':
          records = await this.lists.listDecisions(runner, ctx, filters);
          break;
        case 'meetings':
          records = await this.lists.listMeetings(runner, ctx, filters);
          break;
        case 'files':
          records = await this.lists.listFiles(runner, ctx, {
            ...filters,
            location: str(query['location']),
            scan: str(query['scan']),
          });
          break;
        case 'requests':
          records = await this.lists.listRequests(runner, ctx, filters);
          break;
      }
      const viaSupport = await this.lists.deletedBySupport(
        runner,
        ctx,
        records.filter((r) => r.deletedAt !== null).map((r) => r.id),
      );
      return { area, rows: records.map((record) => toRowView(record, viaSupport)) };
    });
  }

  /** A channel's messages (or one thread), a DM's messages, or a client request's messages. */
  async messages(
    actor: PlatformAdminActor,
    organizationId: string,
    conversationId: string,
    query: ContentQuery,
    request: SupportRequest,
  ): Promise<PlatformContentMessagesView> {
    const scope = await this.support.resolve(actor, organizationId, request);
    const kind =
      query['kind'] === 'dm' ? 'dm' : query['kind'] === 'request' ? 'request' : 'channel';
    const before = sequenceOf(query['before'], 'before');
    const after = sequenceOf(query['after'], 'after');
    const limit = limitOf(query['limit']);
    return this.database.read(scope.context, async (runner) => {
      const ctx = scope.context;
      const records =
        kind === 'dm'
          ? await this.lists.listDirectMessages(runner, ctx, conversationId, {
              before,
              after,
              limit,
            })
          : kind === 'request'
            ? await this.lists.listRequestMessages(runner, ctx, conversationId, limit)
            : await this.lists.listMessages(runner, ctx, conversationId, {
                parentMessageId: str(query['parentMessageId']),
                before,
                after,
                limit,
              });
      const viaSupport = await this.lists.deletedBySupport(
        runner,
        ctx,
        records.filter((r) => r.deletedAt !== null).map((r) => r.id),
      );
      return {
        conversationId,
        kind,
        messages: records.map((record) => toRowView(record, viaSupport)),
      };
    });
  }

  // ── B6 ────────────────────────────────────────────────────────────────────

  async item(
    actor: PlatformAdminActor,
    organizationId: string,
    kindRaw: string,
    id: string,
    request: SupportRequest,
  ): Promise<PlatformContentItemView> {
    const kind = kindOf(kindRaw);
    const scope = await this.support.resolve(actor, organizationId, request);
    return this.database.read(scope.context, (runner) => this.itemView(runner, scope, kind, id));
  }

  /** The deliverable a file belongs to, with its versions and their approval states. */
  async deliverable(
    actor: PlatformAdminActor,
    organizationId: string,
    deliverableId: string,
    request: SupportRequest,
  ): Promise<{ readonly versions: readonly PlatformContentVersionView[] }> {
    const scope = await this.support.resolve(actor, organizationId, request);
    const versions = await this.database.read(scope.context, (runner) =>
      this.lists.deliverableVersions(runner, scope.context, { deliverableId }),
    );
    if (versions.length === 0) throw notFound();
    return { versions: versions.map(versionView) };
  }

  async edit(
    actor: PlatformAdminActor,
    organizationId: string,
    kindRaw: string,
    id: string,
    body: EditBody,
    request: SupportRequest,
  ): Promise<PlatformContentWriteView> {
    const kind = kindOf(kindRaw);
    const reason = optionalReason(body.reason);
    const scope = await this.support.resolve(actor, organizationId, request);
    const before = await this.requireRecord(scope, kind, id);
    await this.refuseLocked(actor, scope, kind, before, 'edit', request);
    if (!EDITABLE_KINDS.includes(kind)) {
      throw new ApiError(409, 'conflict', APPEND_ONLY_MESSAGE, undefined, 'append_only');
    }
    if (before.deletedAt !== null) {
      throw new ApiError(
        409,
        'conflict',
        'Restore this item before changing it',
        undefined,
        'deleted',
      );
    }
    const changes = await this.applyEdit(scope, kind, before, body);
    if (changes.length === 0) return { item: toRowView(before, new Set()) };
    await this.platformAudit.record({
      actor,
      action: 'platform.content_edited',
      targetType: 'content',
      targetId: id,
      targetLabel: `${kind} ${before.title}`.slice(0, 190),
      organizationId: scope.organizationId,
      supportSessionId: scope.session.id,
      before: Object.fromEntries(changes.map((c) => [c.field, c.before])),
      after: Object.fromEntries(changes.map((c) => [c.field, c.after])),
      reason,
      reasonRequired: false,
      request: request.request,
      correlationId: request.correlationId,
    });
    return { item: await this.rowAfter(scope, kind, id) };
  }

  async remove(
    actor: PlatformAdminActor,
    organizationId: string,
    kindRaw: string,
    id: string,
    body: { readonly reason?: unknown },
    request: SupportRequest,
  ): Promise<PlatformContentWriteView> {
    const kind = kindOf(kindRaw);
    // Moderation delete is on the destructive list (SPEC P6): no reason, nothing happens.
    const reason = requireReason(body.reason);
    const scope = await this.support.resolve(actor, organizationId, request);
    const before = await this.requireRecord(scope, kind, id);
    await this.refuseLocked(actor, scope, kind, before, 'delete', request);
    if (before.deletedAt === null) {
      await this.database.transaction(scope.context, async (tx) => {
        const ctx = scope.context;
        if (kind === 'message') {
          await this.org.messages.moderateMessage(tx, ctx, id, ctx.userId, reason);
        } else if (kind === 'work_item') {
          await this.org.workItemsRepository.softDelete(tx, ctx, id, reason);
        } else {
          await this.lists.softDelete(tx, ctx, kind, id, reason);
        }
        await this.audit.record(tx, ctx, {
          action: CONTENT_KIND_DEFINITIONS[kind].deleteAction,
          objectId: id,
          result: 'allowed',
          metadata: metadataFor(kind, before, ctx),
          changes: [
            { field: 'deleted_at', before: null, after: 'now' },
            { field: 'deleted_reason', before: null, after: reason },
          ],
        });
      });
      await this.platformAudit.record({
        actor,
        action: 'platform.content_deleted',
        targetType: 'content',
        targetId: id,
        targetLabel: kind,
        organizationId: scope.organizationId,
        supportSessionId: scope.session.id,
        reason,
        reasonRequired: true,
        request: request.request,
        correlationId: request.correlationId,
      });
    }
    return { item: await this.rowAfter(scope, kind, id) };
  }

  async restore(
    actor: PlatformAdminActor,
    organizationId: string,
    kindRaw: string,
    id: string,
    body: { readonly reason?: unknown },
    request: SupportRequest,
  ): Promise<PlatformContentWriteView> {
    const kind = kindOf(kindRaw);
    const reason = optionalReason(body.reason);
    const scope = await this.support.resolve(actor, organizationId, request);
    const before = await this.requireRecord(scope, kind, id);
    if (before.deletedAt !== null) {
      await this.database.transaction(scope.context, async (tx) => {
        const ctx = scope.context;
        const restored = await this.lists.restore(tx, ctx, kind, id);
        if (!restored) return;
        await this.audit.record(tx, ctx, {
          action: CONTENT_KIND_DEFINITIONS[kind].restoreAction,
          objectId: id,
          result: 'allowed',
          metadata: {
            ...metadataFor(kind, before, ctx),
            deleted_by_user_id: before.deletedByUserId,
          },
          changes: [
            { field: 'deleted_at', before: iso(before.deletedAt), after: null },
            { field: 'deleted_reason', before: before.deletedReason, after: null },
          ],
        });
      });
      await this.platformAudit.record({
        actor,
        action: 'platform.content_restored',
        targetType: 'content',
        targetId: id,
        targetLabel: kind,
        organizationId: scope.organizationId,
        supportSessionId: scope.session.id,
        reason,
        reasonRequired: false,
        request: request.request,
        correlationId: request.correlationId,
      });
    }
    return { item: await this.rowAfter(scope, kind, id) };
  }

  /** The proxied, audited download (`file_asset.downloaded` with the support session stamped). */
  async download(
    actor: PlatformAdminActor,
    organizationId: string,
    fileId: string,
    request: SupportRequest,
  ): Promise<FileDownload> {
    const scope = await this.support.resolve(actor, organizationId, request);
    const download = await this.org.downloads.download(scope.context, scope.principal, fileId);
    await this.platformAudit.record({
      actor,
      action: 'platform.content_downloaded',
      targetType: 'content',
      targetId: fileId,
      targetLabel: download.fileName.slice(0, 190),
      organizationId: scope.organizationId,
      supportSessionId: scope.session.id,
      reason: null,
      reasonRequired: false,
      request: request.request,
      correlationId: request.correlationId,
    });
    return download;
  }

  // ── B7 ────────────────────────────────────────────────────────────────────

  async trash(
    actor: PlatformAdminActor,
    organizationId: string,
    query: ContentQuery,
    request: SupportRequest,
  ): Promise<PlatformContentTrashView> {
    const scope = await this.support.resolve(actor, organizationId, request);
    const kindRaw = query['kind'];
    let kinds: readonly ContentKind[] = TRASH_KINDS;
    if (typeof kindRaw === 'string' && kindRaw !== '') {
      if (kindRaw === 'comment') kinds = TRASH_KINDS.filter((k) => k.endsWith('_comment'));
      else if (isContentKind(kindRaw)) kinds = [kindRaw];
      else {
        throw new ApiError(400, 'validation_failed', 'The query is invalid', [
          { field: 'kind', message: 'unknown kind' },
        ]);
      }
    }
    const supportOnly = query['supportOnly'] === 'true' || query['supportOnly'] === '1';
    return this.database.read(scope.context, async (runner) => {
      const records = await this.lists.trash(runner, scope.context, {
        kinds,
        actor: str(query['actor']),
        q: str(query['q']),
        limit: limitOf(query['limit']),
      });
      const viaSupport = await this.lists.deletedBySupport(
        runner,
        scope.context,
        records.map((r) => r.id),
      );
      const rows = records
        .map((record) => toRowView(record, viaSupport))
        .filter((row) => !supportOnly || row.deletedViaSupport);
      return { rows, purgeDays: await contentPurgeDays(runner) };
    });
  }

  // ── internals ─────────────────────────────────────────────────────────────

  private async organizationOf(
    runner: TenantQueryRunner,
    scope: SupportScope,
  ): Promise<PlatformContentOrgView> {
    const organization = await this.lists.organization(runner, scope.organizationId);
    if (!organization) throw notFound();
    return organization;
  }

  private async requireRecord(scope: SupportScope, kind: ContentKind, id: string) {
    const record = await this.database.read(scope.context, (runner) =>
      this.lists.findOne(runner, scope.context, kind, id),
    );
    if (!record) throw notFound();
    return record;
  }

  private async rowAfter(
    scope: SupportScope,
    kind: ContentKind,
    id: string,
  ): Promise<PlatformContentRowView> {
    return this.database.read(scope.context, async (runner) => {
      const record = await this.lists.findOne(runner, scope.context, kind, id);
      if (!record) throw notFound();
      const via = await this.lists.deletedBySupport(
        runner,
        scope.context,
        record.deletedAt ? [record.id] : [],
      );
      return toRowView(record, via);
    });
  }

  private async itemView(
    runner: TenantQueryRunner,
    scope: SupportScope,
    kind: ContentKind,
    id: string,
  ): Promise<PlatformContentItemView> {
    const record = await this.lists.findOne(runner, scope.context, kind, id);
    if (!record) throw notFound();
    const organization = await this.organizationOf(runner, scope);
    const history = await this.lists.history(runner, scope.context, id);
    const versions =
      kind === 'file'
        ? await this.lists.deliverableVersions(runner, scope.context, { fileAssetId: id })
        : [];
    const via = await this.lists.deletedBySupport(
      runner,
      scope.context,
      record.deletedAt ? [id] : [],
    );
    const lock = lockOf(kind, id, versions);
    return {
      organization,
      item: toRowView(record, via),
      body: record.deletedAt !== null && kind !== 'file' ? null : record.body,
      version: record.version,
      editable: lock || record.deletedAt ? [] : (EDITABLE_FIELDS[kind] ?? []),
      locked: lock ?? (EDITABLE_KINDS.includes(kind) ? null : appendOnlyLock(kind)),
      history: history.map(historyView),
      deliverableVersions: versions.map(versionView),
      openInApp: openInAppPath(organization.slug, record),
    };
  }

  /** An approved deliverable version is locked for everyone: refuse, explain, record. */
  private async refuseLocked(
    actor: PlatformAdminActor,
    scope: SupportScope,
    kind: ContentKind,
    record: ContentRecord,
    attempt: 'edit' | 'delete',
    request: SupportRequest,
  ): Promise<void> {
    if (kind !== 'file') return;
    const versions = await this.database.read(scope.context, (runner) =>
      this.lists.deliverableVersions(runner, scope.context, { fileAssetId: record.id }),
    );
    if (!lockOf(kind, record.id, versions)) return;
    await this.platformAudit.record({
      actor,
      action: 'platform.content_edit_refused',
      targetType: 'content',
      targetId: record.id,
      targetLabel: `${attempt} refused: version_locked`,
      organizationId: scope.organizationId,
      supportSessionId: scope.session.id,
      reason: null,
      reasonRequired: false,
      request: request.request,
      correlationId: request.correlationId,
    });
    throw new ApiError(409, 'conflict', VERSION_LOCKED_MESSAGE, undefined, 'version_locked');
  }

  private async applyEdit(
    scope: SupportScope,
    kind: ContentKind,
    before: ContentRecord & { readonly body: string | null; readonly version: number | null },
    body: EditBody,
  ): Promise<AuditChangeInput[]> {
    const ctx = scope.context;
    const principal = scope.principal;
    const changes: AuditChangeInput[] = [];
    let action: AuditAction;
    switch (kind) {
      case 'message': {
        const next = typeof body.body === 'string' ? body.body.trim() : '';
        if (next === '' || next.length > MAX_BODY) {
          throw invalid('body', `must be 1–${MAX_BODY} characters`);
        }
        if (next === before.body) return [];
        changes.push({ field: 'body', before: before.body, after: next });
        await this.database.transaction(ctx, async (tx) => {
          await this.org.messages.editMessage(tx, ctx, before.id, next, null);
          await this.audit.record(tx, ctx, {
            action: 'message.edited',
            objectId: before.id,
            result: 'allowed',
            metadata: metadataFor(kind, before, ctx),
            changes,
          });
        });
        return changes;
      }
      case 'work_item': {
        const input: {
          title?: string;
          description?: string | null;
          ownerUserId?: string | null;
          dueAt?: Date | null;
        } = {};
        if (body.title !== undefined) {
          const title = typeof body.title === 'string' ? body.title.trim() : '';
          if (title === '' || title.length > MAX_TITLE)
            throw invalid('title', 'must be 1–300 characters');
          if (title !== before.title) {
            input.title = title;
            changes.push({ field: 'title', before: before.title, after: title });
          }
        }
        if (body.description !== undefined) {
          const description = typeof body.description === 'string' ? body.description.trim() : null;
          const next = description === '' ? null : description;
          if (next !== before.body) {
            input.description = next;
            changes.push({ field: 'description', before: before.body, after: next });
          }
        }
        if (body.ownerUserId !== undefined) {
          const owner = str(body.ownerUserId);
          if (owner !== before.authorUserId) {
            input.ownerUserId = owner;
            changes.push({ field: 'assignee', before: before.authorName, after: owner });
          }
        }
        if (body.dueAt !== undefined) {
          const raw = str(body.dueAt);
          const due = raw === null ? null : new Date(raw);
          if (due !== null && Number.isNaN(due.getTime())) throw invalid('dueAt', 'must be a date');
          if ((due?.getTime() ?? null) !== (before.dueAt?.getTime() ?? null)) {
            input.dueAt = due;
            changes.push({ field: 'due', before: iso(before.dueAt), after: iso(due) });
          }
        }
        let version = before.version ?? 0;
        if (Object.keys(input).length > 0) {
          const updated = await this.org.workItems.update(
            ctx,
            principal,
            before.id,
            version,
            input,
          );
          version = updated.version;
        }
        if (body.state !== undefined) {
          const state = str(body.state);
          if (state === null || !isWorkItemState(state)) throw invalid('state', 'unknown state');
          if (state !== before.state) {
            await this.org.workItems.transition(ctx, principal, before.id, version, state as never);
            changes.push({ field: 'state', before: before.state, after: state });
          }
        }
        action = 'work_item.updated';
        break;
      }
      case 'doc': {
        const title = typeof body.title === 'string' ? body.title.trim() : '';
        if (title === '' || title.length > MAX_TITLE)
          throw invalid('title', 'must be 1–300 characters');
        if (title === before.title) return [];
        await this.org.documents.rename(ctx, principal, before.id, {
          title,
          expectedUpdatedAt: (before.updatedAt ?? before.createdAt).toISOString(),
        });
        changes.push({ field: 'title', before: before.title, after: title });
        action = 'document.renamed';
        break;
      }
      case 'decision': {
        const rationale = typeof body.rationale === 'string' ? body.rationale.trim() : null;
        await this.org.decisions.updateDetails(ctx, principal, before.id, {
          rationale: rationale === '' ? null : rationale,
        });
        changes.push({ field: 'rationale', before: null, after: rationale });
        action = 'decision.updated';
        break;
      }
      case 'meeting': {
        const input: { title?: string; agendaNote?: string | null } = {};
        if (body.title !== undefined) {
          const title = typeof body.title === 'string' ? body.title.trim() : '';
          if (title === '' || title.length > MAX_TITLE)
            throw invalid('title', 'must be 1–300 characters');
          if (title !== before.title) {
            input.title = title;
            changes.push({ field: 'title', before: before.title, after: title });
          }
        }
        if (body.agendaNote !== undefined) {
          const note = typeof body.agendaNote === 'string' ? body.agendaNote.trim() : null;
          const next = note === '' ? null : note;
          if (next !== before.body) {
            input.agendaNote = next;
            changes.push({ field: 'agenda', before: before.body, after: next });
          }
        }
        if (Object.keys(input).length === 0) return [];
        await this.org.meetings.update(ctx, principal, before.id, input);
        action = 'meeting.updated';
        break;
      }
      default:
        throw new ApiError(409, 'conflict', APPEND_ONLY_MESSAGE, undefined, 'append_only');
    }
    if (changes.length === 0) return [];
    await this.audit.recordStandalone(ctx, {
      action,
      objectId: before.id,
      result: 'allowed',
      metadata: metadataFor(kind, before, ctx),
      changes,
    });
    return changes;
  }
}

function kindOf(raw: string): ContentKind {
  const kind = isContentKind(raw) ? raw : commentKindOf(raw);
  if (kind === null) throw notFound();
  return kind;
}

/** Identifiers only — the audit metadata gate refuses anything that reads like content. */
function metadataFor(
  kind: ContentKind,
  record: ContentRecord,
  context: TenantContext,
): AuditMetadata {
  return {
    object_kind: kind,
    project_id: record.projectId,
    author_user_id: record.authorUserId,
    via_support: context.userId !== record.authorUserId,
  };
}

function lockOf(
  kind: ContentKind,
  fileId: string,
  versions: readonly DeliverableVersionRecord[],
): PlatformContentLockView | null {
  if (kind !== 'file') return null;
  const approved = versions.find(
    (version) => version.fileAssetId === fileId && version.approvalState === 'approved',
  );
  if (!approved) return null;
  return {
    code: 'version_locked',
    approvedAt: iso(approved.approvedAt),
    approvedByName: approved.approvedByName,
  };
}

function appendOnlyLock(kind: ContentKind): PlatformContentLockView | null {
  if (!CONTENT_KIND_DEFINITIONS[kind].appendOnly) return null;
  return { code: 'append_only', approvedAt: null, approvedByName: null };
}
