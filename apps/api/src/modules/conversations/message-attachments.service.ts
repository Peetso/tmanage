import { authorize, SERVABLE_UPLOAD_STATES } from '@tmanage/domain';
import type { Principal, UploadState } from '@tmanage/domain';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import type {
  TenantContext,
  TenantDatabase,
  TenantQueryRunner,
} from '../../common/database/tenant-context.js';
import type { MessageRow } from '../../common/database/schema.js';
import { FileAssetsRepository } from '../files/file-assets.repository.js';
import { ConversationsRepository } from './conversations.repository.js';
import { MessageAttachmentsRepository } from './message-attachments.repository.js';

/**
 * x275 — a message author links an already-uploaded file to their message, and any reader of the
 * conversation lists a message's attachments (CH-06's composer attachments). There is no upload
 * here: the file store (`file_assets`) is reused read-only.
 *
 * ## The gate is the conversation's, resolved before it is applied
 *
 * Attaching and detaching are gated on `conversation.write`, listing on `conversation.read` — the
 * same ceilings `ConversationsService` applies to writing and reading a message. The order mirrors
 * `MessageBookmarksService.resolveReadable`: the conversation, the message and (for a write) the
 * file are resolved tenant-scoped **first** — a row that does not exist, a message that belongs to
 * another conversation, or a file that is not in this tenant or not yet `ready` is a 404 with no
 * authorization leak and no write — then the capability's resource gate runs, then conversation
 * membership (unless the caller holds organization-wide scope). Only a caller who passes every
 * half reaches the insert.
 *
 * ## Why 404 and not 403 for the gate, but 403 for authorship
 *
 * A caller with no relation to the conversation is told "not found", because a channel's existence
 * is itself information (`ConversationsService`'s rule). Authorship is different: a caller who *can*
 * write the conversation but is not the message's author is refused with 403 — they already know
 * the message exists, so "you are not its author" leaks nothing, and CH-06 scopes attach/detach to
 * the author of the message being edited.
 *
 * ## The file must be readable
 *
 * A file is attachable only once it is `ready` (`23-ERD` §10 / `SERVABLE_UPLOAD_STATES`): verified,
 * scanned clean and promoted. A draft, scanning or rejected asset resolves to a 404 here, so a
 * message never references bytes that are not servable.
 */

/** What a caller sees of one attached file. `sizeBytes` is `null` before the file's first version. */
export interface MessageAttachmentView {
  readonly fileAssetId: string;
  readonly name: string;
  readonly sizeBytes: number | null;
  readonly attachedAt: string;
}

export class MessageAttachmentsService {
  constructor(
    private readonly database: TenantDatabase,
    private readonly attachments: MessageAttachmentsRepository = new MessageAttachmentsRepository(),
    private readonly conversations: ConversationsRepository = new ConversationsRepository(),
    private readonly files: FileAssetsRepository = new FileAssetsRepository(),
  ) {}

  /**
   * Attach a file to a message. Idempotent: attaching one already attached is a no-op that returns
   * the existing link. The conversation, message and file are resolved, the write gate and the
   * author check applied, all before the insert — a caller who cannot reach the message, or a file
   * not in this tenant or not `ready`, gets a 404 (or the author a 403) and nothing is written.
   */
  async attach(
    context: TenantContext,
    principal: Principal,
    conversationId: string,
    messageId: string,
    fileId: string,
  ): Promise<{ readonly attachment: MessageAttachmentView; readonly created: boolean }> {
    return this.database.transaction(context, async (tx) => {
      await this.resolveAuthoredMessage(context, principal, conversationId, messageId, tx);
      await this.resolveReadableFile(context, fileId, tx);
      const { row, created } = await this.attachments.insert(tx, context, {
        messageId,
        fileAssetId: fileId,
      });
      const listed = await this.attachments.listForMessage(tx, context, messageId);
      const view = listed.find((item) => item.fileAssetId === fileId);
      // The row was just written in this transaction, so the projection always finds it; the
      // fallback keeps the type honest without inventing a size.
      const attachment: MessageAttachmentView = view
        ? {
            fileAssetId: view.fileAssetId,
            name: view.name,
            sizeBytes: view.sizeBytes,
            attachedAt: view.attachedAt.toISOString(),
          }
        : {
            fileAssetId: fileId,
            name: '',
            sizeBytes: null,
            attachedAt: row.createdAt.toISOString(),
          };
      return { attachment, created };
    });
  }

  /**
   * Detach a file from a message. Idempotent — detaching one that is not attached removes nothing
   * and still answers 204. The same write gate and author check apply first, so a detach cannot be
   * used to probe a conversation the caller has no relation to.
   */
  async detach(
    context: TenantContext,
    principal: Principal,
    conversationId: string,
    messageId: string,
    fileId: string,
  ): Promise<void> {
    await this.database.transaction(context, async (tx) => {
      await this.resolveAuthoredMessage(context, principal, conversationId, messageId, tx);
      // The file is resolved tenant-scoped (a cross-tenant id is a 404), but a detach does not
      // require it to still be `ready`: removing a link to a file that has since been rejected is
      // exactly the cleanup a caller wants.
      const file = await this.files.findById(tx, context, fileId);
      if (!file) throw new ApiError(404, 'not_found', MESSAGES.notFound);
      await this.attachments.deleteLink(tx, context, messageId, fileId);
    });
  }

  /** A message's attachments, oldest first. Gated on `conversation.read` and the relation gate. */
  async list(
    context: TenantContext,
    principal: Principal,
    conversationId: string,
    messageId: string,
  ): Promise<readonly MessageAttachmentView[]> {
    const rows = await this.database.read(context, async (runner) => {
      await this.resolveReadableMessage(context, principal, conversationId, messageId, runner);
      return this.attachments.listForMessage(runner, context, messageId);
    });
    return rows.map((row) => ({
      fileAssetId: row.fileAssetId,
      name: row.name,
      sizeBytes: row.sizeBytes,
      attachedAt: row.attachedAt.toISOString(),
    }));
  }

  /**
   * Resolve the conversation and message tenant-scoped, apply the `conversation.read` gate, then
   * the membership relation gate. 404 in every failing case, before anything else runs.
   */
  private async resolveReadableMessage(
    context: TenantContext,
    principal: Principal,
    conversationId: string,
    messageId: string,
    runner: TenantQueryRunner,
  ): Promise<MessageRow> {
    return this.resolveMessage(
      context,
      principal,
      conversationId,
      messageId,
      'conversation.read',
      runner,
    );
  }

  /**
   * Resolve as {@link resolveMessage} does under `conversation.write`, then require the caller to be
   * the message's author — 403 otherwise. The author check is last: it is reached only by a caller
   * who has already passed the write gate and the membership gate, so revealing "you are not the
   * author" leaks nothing about a conversation they cannot see.
   */
  private async resolveAuthoredMessage(
    context: TenantContext,
    principal: Principal,
    conversationId: string,
    messageId: string,
    runner: TenantQueryRunner,
  ): Promise<MessageRow> {
    const message = await this.resolveMessage(
      context,
      principal,
      conversationId,
      messageId,
      'conversation.write',
      runner,
    );
    if (message.authorUserId !== principal.userId) {
      throw new ApiError(403, 'forbidden', MESSAGES.forbidden);
    }
    return message;
  }

  /**
   * The shared spine: resolve the conversation and the message tenant-scoped (a missing row, or a
   * message that belongs to another conversation, is a 404), apply the capability's resource gate
   * (404 on denial, never 403 — the channel's existence is information), then the membership
   * relation gate unless the caller holds organization-wide scope.
   */
  private async resolveMessage(
    context: TenantContext,
    principal: Principal,
    conversationId: string,
    messageId: string,
    capability: 'conversation.read' | 'conversation.write',
    runner: TenantQueryRunner,
  ): Promise<MessageRow> {
    const conversation = await this.conversations.findById(runner, context, conversationId);
    if (!conversation) throw new ApiError(404, 'not_found', MESSAGES.notFound);

    const message = await this.conversations.findMessageById(runner, context, messageId);
    if (!message || message.conversationId !== conversationId) {
      throw new ApiError(404, 'not_found', MESSAGES.notFound);
    }

    const verdict = authorize({
      principal,
      capability,
      resource: {
        organizationId: conversation.organizationId,
        projectId: conversation.projectId,
        audience: 'internal',
        lifecycle: conversation.archivedAt === null ? 'active' : 'archived',
      },
    });
    if (!verdict.allowed) throw new ApiError(404, 'not_found', MESSAGES.notFound);

    if (!principal.hasOrgWideScope) {
      const membership = await this.conversations.findMembership(
        runner,
        context,
        conversationId,
        principal.userId,
      );
      if (!membership) throw new ApiError(404, 'not_found', MESSAGES.notFound);
    }

    return message;
  }

  /**
   * Resolve the file tenant-scoped and require it to be `ready`. A file not in this tenant, or one
   * still in flight (draft, scanning) or rejected, is a 404 — the refusal path the unit test proves,
   * with no insert. Tenant scoping means a cross-tenant `fileId` resolves to no row at all.
   */
  private async resolveReadableFile(
    context: TenantContext,
    fileId: string,
    runner: TenantQueryRunner,
  ): Promise<void> {
    const file = await this.files.findById(runner, context, fileId);
    if (!file || !SERVABLE_UPLOAD_STATES.includes(file.status as UploadState)) {
      throw new ApiError(404, 'not_found', MESSAGES.notFound);
    }
  }
}
