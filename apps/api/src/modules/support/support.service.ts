import { uuidv7 } from '@tmanage/domain';
import type { Mailer } from '@tmanage/mail';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import type { FileAssetsRepository } from '../files/file-assets.repository.js';
import type { NotificationsRepository } from '../inbox/notifications.repository.js';
import type { PlatformRequestContext } from '../platform-admin/platform-admin.access.js';
import { optionalReason, requireId } from '../platform-admin/platform-admin.access.js';
import type { PlatformAdminActor } from '../platform-admin/platform-admin.guard.js';
import { insertPlatformAudit } from '../platform-admin/platform-admin.repository.js';
import { platformAuditFor } from '../platform-admin/platform-audit.service.js';
import { platformOrgContext } from '../platform-admin/organizations/organizations.repository.js';
import { buildSupportReplyEmail } from './support-email.js';
import {
  maySeeThread,
  mayWriteInThread,
  parseNewMessage,
  parseNewThread,
  parseStatus,
  seesWholeOrganization,
  statusAfterMessage,
} from './support.policy.js';
import type { SupportAuthorKind, SupportStatus } from './support.policy.js';
import type {
  SupportMessageRecord,
  SupportRepository,
  SupportThreadRecord,
} from './support.repository.js';

/**
 * 55-17 — in-app support conversations to the TManage platform team.
 *
 * Member side (`/v1/organizations/:orgSlug/support/threads…`): the server, not the screen,
 * decides what a person sees — their own threads, or all of the organization's for an org admin
 * (`support.policy.ts`). A thread outside that set answers 404, so a guessed id confirms nothing.
 *
 * Platform side (`/v1/platform/support/threads…`): the cross-organization list runs on the
 * bootstrap path with a recorded reason and only the declared tables; reading one thread and
 * replying run under a service context for the thread's own organization, and every reply or
 * status change writes a platform audit row in the same transaction. A reply also writes the
 * person's in-app notification there, and after commit sends the e-mail (reply-to
 * `tm-support@peetrix.com`); a mail failure never undoes the reply.
 */

export const SUPPORT_LIST_REASON =
  'platform support inbox: the TManage operator lists the support conversations people opened ' +
  'with the platform team, across organizations (55-17)';

export const SUPPORT_BOOTSTRAP_TABLES = ['support_threads', 'organizations'] as const;

export const SUPPORT_NOTIFICATION_TYPE = 'support.reply_posted';
export const SUPPORT_OBJECT_TYPE = 'support_thread';

export const PLATFORM_SUPPORT_ACTIONS = {
  replied: 'platform.support_replied',
  statusChanged: 'platform.support_status_changed',
} as const;

type Body = Readonly<Record<string, unknown>>;

export interface SupportMessageView {
  readonly id: string;
  readonly authorKind: SupportAuthorKind;
  readonly authorName: string | null;
  readonly mine: boolean;
  readonly body: string;
  readonly attachmentName: string | null;
  readonly createdAt: string;
}

export interface SupportThreadView {
  readonly id: string;
  readonly subject: string;
  readonly status: SupportStatus;
  readonly contextPath: string | null;
  readonly appVersion: string | null;
  readonly startedByName: string | null;
  readonly mine: boolean;
  readonly messageCount: number;
  readonly lastAuthorKind: SupportAuthorKind;
  readonly lastMessageAt: string;
  readonly createdAt: string;
  readonly closedAt: string | null;
}

export interface SupportThreadDetailView {
  readonly thread: SupportThreadView;
  readonly organizationSlug: string | null;
  readonly messages: readonly SupportMessageView[];
}

export interface PlatformSupportThreadView extends SupportThreadView {
  readonly organizationId: string;
  readonly organizationSlug: string | null;
  readonly organizationName: string | null;
  readonly startedByEmail: string | null;
}

export interface PlatformSupportDetailView {
  readonly thread: PlatformSupportThreadView;
  readonly messages: readonly SupportMessageView[];
}

export interface SupportServiceDeps {
  readonly database: TenantDatabase;
  readonly repository: SupportRepository;
  readonly files: Pick<FileAssetsRepository, 'findById'>;
  readonly notifications: Pick<NotificationsRepository, 'insertForRecipient'>;
  readonly mailer: Mailer | null;
  readonly webPublicUrl: string;
  readonly now?: () => Date;
  readonly onMailError?: (error: unknown) => void;
}

function iso(value: Date | null): string | null {
  return value === null ? null : value.toISOString();
}

function notFound(): ApiError {
  return new ApiError(404, 'not_found', MESSAGES.notFound);
}

function threadView(thread: SupportThreadRecord, viewerUserId: string | null): SupportThreadView {
  return {
    id: thread.id,
    subject: thread.subject,
    status: thread.status,
    contextPath: thread.contextPath,
    appVersion: thread.contextAppVersion,
    startedByName: thread.startedByName,
    mine: viewerUserId !== null && thread.startedByUserId === viewerUserId,
    messageCount: thread.messageCount,
    lastAuthorKind: thread.lastAuthorKind,
    lastMessageAt: thread.lastMessageAt.toISOString(),
    createdAt: thread.createdAt.toISOString(),
    closedAt: iso(thread.closedAt),
  };
}

function platformThreadView(thread: SupportThreadRecord): PlatformSupportThreadView {
  return {
    ...threadView(thread, null),
    organizationId: thread.organizationId,
    organizationSlug: thread.organizationSlug,
    organizationName: thread.organizationName,
    startedByEmail: thread.startedByEmail,
  };
}

/**
 * A member reads the platform team's messages as "TManage support": the name of the person on
 * the team is not shown to customers.
 */
function messageView(message: SupportMessageRecord, viewerUserId: string | null, platform = false) {
  return {
    id: message.id,
    authorKind: message.authorKind,
    authorName: message.authorKind === 'platform' && !platform ? null : message.authorName,
    mine: viewerUserId !== null && message.authorUserId === viewerUserId,
    body: message.body,
    attachmentName: message.attachmentName,
    createdAt: message.createdAt.toISOString(),
  } satisfies SupportMessageView;
}

export class SupportService {
  private readonly now: () => Date;

  constructor(private readonly deps: SupportServiceDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  // ── Member side ─────────────────────────────────────────────────────────

  async list(context: TenantContext): Promise<readonly SupportThreadView[]> {
    this.requireInternal(context);
    const startedBy = seesWholeOrganization(context) ? null : context.userId;
    const rows = await this.deps.database.read(context, (db) =>
      this.deps.repository.list(db, context, startedBy),
    );
    return rows.map((row) => threadView(row, context.userId));
  }

  async get(context: TenantContext, rawId: string): Promise<SupportThreadDetailView> {
    this.requireInternal(context);
    const id = requireId(rawId);
    return this.deps.database.read(context, async (db) => {
      const thread = await this.deps.repository.find(db, context, id);
      if (!thread || !maySeeThread(context, thread)) throw notFound();
      const label = await this.deps.repository.organizationLabel(db, context);
      const messages = await this.deps.repository.messages(db, context, id);
      return {
        thread: threadView(thread, context.userId),
        organizationSlug: label?.slug ?? null,
        messages: messages.map((m) => messageView(m, context.userId)),
      };
    });
  }

  async create(context: TenantContext, body: Body): Promise<SupportThreadDetailView> {
    this.requireInternal(context);
    const input = parseNewThread(body);
    const id = uuidv7();
    const at = this.now();
    await this.deps.database.transaction(context, async (tx) => {
      const attachmentName = await this.attachment(tx, context, input.attachmentFileId);
      await this.deps.repository.insertThread(tx, context, {
        id,
        startedByUserId: context.userId,
        subject: input.subject,
        contextPath: input.contextPath,
        contextAppVersion: input.appVersion,
        at,
      });
      await this.deps.repository.appendMessage(
        tx,
        context,
        {
          id: uuidv7(),
          threadId: id,
          authorKind: 'member',
          authorUserId: context.userId,
          body: input.body,
          attachmentFileId: input.attachmentFileId,
          attachmentName,
          at,
        },
        'open',
      );
    });
    return this.get(context, id);
  }

  async postMessage(
    context: TenantContext,
    rawId: string,
    body: Body,
  ): Promise<SupportThreadDetailView> {
    this.requireInternal(context);
    const id = requireId(rawId);
    const input = parseNewMessage(body);
    const at = this.now();
    await this.deps.database.transaction(context, async (tx) => {
      const thread = await this.deps.repository.find(tx, context, id, true);
      if (!thread || !maySeeThread(context, thread)) throw notFound();
      if (!mayWriteInThread(context, thread)) {
        throw new ApiError(403, 'forbidden', MESSAGES.forbidden);
      }
      const attachmentName = await this.attachment(tx, context, input.attachmentFileId);
      await this.deps.repository.appendMessage(
        tx,
        context,
        {
          id: uuidv7(),
          threadId: id,
          authorKind: 'member',
          authorUserId: context.userId,
          body: input.body,
          attachmentFileId: input.attachmentFileId,
          attachmentName,
          at,
        },
        statusAfterMessage('member'),
      );
    });
    return this.get(context, id);
  }

  /** The person who started a thread may close it; an org admin may too. */
  async close(context: TenantContext, rawId: string): Promise<SupportThreadDetailView> {
    this.requireInternal(context);
    const id = requireId(rawId);
    await this.deps.database.transaction(context, async (tx) => {
      const thread = await this.deps.repository.find(tx, context, id, true);
      if (!thread || !maySeeThread(context, thread)) throw notFound();
      if (thread.status !== 'closed') {
        await this.deps.repository.setStatus(tx, context, id, 'closed', this.now());
      }
    });
    return this.get(context, id);
  }

  // ── Platform side ───────────────────────────────────────────────────────

  async platformList(correlationId: string): Promise<readonly PlatformSupportThreadView[]> {
    const rows = await this.deps.database.bootstrapRead(
      { correlationId, reason: SUPPORT_LIST_REASON, tables: [...SUPPORT_BOOTSTRAP_TABLES] },
      (db) => this.deps.repository.listAcrossOrganizations(db),
    );
    return rows.map(platformThreadView);
  }

  async platformGet(rawId: string, correlationId: string): Promise<PlatformSupportDetailView> {
    const id = requireId(rawId);
    const context = await this.platformContextFor(id, correlationId);
    return this.deps.database.read(context, (db) => this.platformDetail(db, context, id));
  }

  async platformReply(
    actor: PlatformAdminActor,
    rawId: string,
    body: Body,
    request: PlatformRequestContext,
  ): Promise<PlatformSupportDetailView> {
    const id = requireId(rawId);
    const input = parseNewMessage(body);
    if (input.attachmentFileId !== null) {
      throw new ApiError(400, 'validation_failed', 'The support team cannot attach files here.', [
        { field: 'attachmentFileId', message: 'not accepted on a platform reply' },
      ]);
    }
    const context = await this.platformContextFor(id, request.correlationId);
    const at = this.now();
    const messageId = uuidv7();
    const { detail, thread } = await this.deps.database.transaction(context, async (tx) => {
      const current = await this.deps.repository.find(tx, context, id, true);
      if (!current) throw notFound();
      await this.deps.repository.appendMessage(
        tx,
        context,
        {
          id: messageId,
          threadId: id,
          authorKind: 'platform',
          authorUserId: actor.account.userId,
          body: input.body,
          attachmentFileId: null,
          attachmentName: null,
          at,
        },
        statusAfterMessage('platform'),
      );
      await this.deps.notifications.insertForRecipient(tx, context, {
        recipientUserId: current.startedByUserId,
        type: SUPPORT_NOTIFICATION_TYPE,
        objectType: SUPPORT_OBJECT_TYPE,
        objectId: id,
        dedupeKey: `support.reply:${messageId}`,
      });
      await insertPlatformAudit(
        tx,
        platformAuditFor(actor, request, {
          action: PLATFORM_SUPPORT_ACTIONS.replied,
          targetType: 'organization',
          targetId: context.organizationId,
          targetLabel: `support thread ${id}`,
          organizationId: context.organizationId,
          reason: null,
        }),
      );
      return { detail: await this.platformDetail(tx, context, id), thread: current };
    });
    await this.sendReplyMail(thread, detail.thread.organizationSlug);
    return detail;
  }

  async platformSetStatus(
    actor: PlatformAdminActor,
    rawId: string,
    body: Body,
    request: PlatformRequestContext,
  ): Promise<PlatformSupportDetailView> {
    const id = requireId(rawId);
    const status = parseStatus(body['status']);
    const reason = optionalReason(body['reason']);
    const context = await this.platformContextFor(id, request.correlationId);
    return this.deps.database.transaction(context, async (tx) => {
      const current = await this.deps.repository.find(tx, context, id, true);
      if (!current) throw notFound();
      if (current.status !== status) {
        await this.deps.repository.setStatus(tx, context, id, status, this.now());
        await insertPlatformAudit(
          tx,
          platformAuditFor(actor, request, {
            action: PLATFORM_SUPPORT_ACTIONS.statusChanged,
            targetType: 'organization',
            targetId: context.organizationId,
            targetLabel: `support thread ${id}`,
            organizationId: context.organizationId,
            reason,
            beforeJson: JSON.stringify({ status: current.status }),
            afterJson: JSON.stringify({ status }),
          }),
        );
      }
      return this.platformDetail(tx, context, id);
    });
  }

  // ── Helpers ─────────────────────────────────────────────────────────────

  private requireInternal(context: TenantContext): void {
    if (context.principalKind !== 'internal') {
      throw new ApiError(403, 'forbidden', MESSAGES.forbidden);
    }
  }

  /** A screenshot must be a live upload of this person, in this organization. */
  private async attachment(
    tx: Parameters<FileAssetsRepository['findById']>[0],
    context: TenantContext,
    fileId: string | null,
  ): Promise<string | null> {
    if (fileId === null) return null;
    const file = await this.deps.files.findById(tx, context, fileId);
    if (!file || file.ownerUserId !== context.userId || file.status === 'rejected') {
      throw new ApiError(400, 'validation_failed', 'Upload the screenshot again.', [
        { field: 'attachmentFileId', message: 'must be your own uploaded file' },
      ]);
    }
    return file.name;
  }

  private async platformContextFor(threadId: string, correlationId: string) {
    const organizationId = await this.deps.database.bootstrapRead(
      { correlationId, reason: SUPPORT_LIST_REASON, tables: [...SUPPORT_BOOTSTRAP_TABLES] },
      (db) => this.deps.repository.organizationOfThread(db, threadId),
    );
    if (organizationId === null) throw notFound();
    return platformOrgContext(organizationId, correlationId);
  }

  private async platformDetail(
    db: Parameters<SupportRepository['find']>[0],
    context: TenantContext,
    id: string,
  ): Promise<PlatformSupportDetailView> {
    const thread = await this.deps.repository.find(db, context, id);
    if (!thread) throw notFound();
    const label = await this.deps.repository.organizationLabel(db, context);
    const messages = await this.deps.repository.messages(db, context, id);
    return {
      thread: platformThreadView({
        ...thread,
        organizationSlug: label?.slug ?? null,
        organizationName: label?.name ?? null,
      }),
      messages: messages.map((m) => messageView(m, null, true)),
    };
  }

  private async sendReplyMail(
    thread: SupportThreadRecord,
    organizationSlug: string | null,
  ): Promise<void> {
    if (this.deps.mailer === null || !thread.startedByEmail || !organizationSlug) return;
    try {
      await this.deps.mailer.send(
        buildSupportReplyEmail({
          to: thread.startedByEmail,
          subject: thread.subject,
          organizationSlug,
          threadId: thread.id,
          webPublicUrl: this.deps.webPublicUrl,
        }),
      );
    } catch (error) {
      this.deps.onMailError?.(error);
    }
  }
}
