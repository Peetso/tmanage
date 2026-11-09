import { authorize } from '@tmanage/domain';
import type { Principal } from '@tmanage/domain';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { MessageKind } from '../../common/database/schema.js';
import type { FileAssetsRepository } from '../files/file-assets.repository.js';
import type { ConversationsRepository } from './conversations.repository.js';
import type { ConversationsService } from './conversations.service.js';
import type { MessageAttachmentsService } from './message-attachments.service.js';

/** R7 slice 4: how many conversations one forward may name. */
export const MAX_FORWARD_TARGETS = 5;

export interface ForwardResultView {
  /** One entry per target that received the copy. */
  readonly forwarded: readonly { readonly conversationId: string; readonly messageId: string }[];
  /** Targets the caller may not write to, or that may not carry the source's files. */
  readonly refused: readonly string[];
}

/**
 * R7 slice 4 — forward a message to up to five conversations.
 *
 * The source is read through `ConversationsService.get` (the read gate: a conversation the caller
 * cannot reach is a 404) and the message must belong to it. Each target is posted through
 * `ConversationsService.postMessage`, so the write gate, archive and only-admins rules stay the
 * service's own; a target that refuses is listed in `refused` rather than failing the others.
 *
 * Attachments are re-linked, not copied: the same file assets go onto the new message through
 * `MessageAttachmentsService.attach`. Before anything is posted to a target, every file is checked
 * the way `attach` checks it (ready, the target's project, `file.download` for the caller), so a
 * target that could not carry the files gets no bare copy of the text either.
 *
 * Meta: a text message carries `{forwardedFromMessageId}`. Voice and location keep their own meta
 * unchanged, because `message-meta.ts` validates those shapes strictly.
 */
export class MessageForwardService {
  constructor(
    private readonly database: TenantDatabase,
    private readonly conversations: Pick<ConversationsService, 'get' | 'postMessage'>,
    private readonly attachments: Pick<MessageAttachmentsService, 'list' | 'attach' | 'fileUsable'>,
    private readonly repository: Pick<ConversationsRepository, 'findMessageById'>,
    private readonly files: Pick<FileAssetsRepository, 'findById'>,
  ) {}

  async forward(
    context: TenantContext,
    principal: Principal,
    conversationId: string,
    messageId: string,
    targetConversationIds: readonly string[],
  ): Promise<ForwardResultView> {
    const targets = [...new Set(targetConversationIds)];
    if (targets.length === 0 || targets.length > MAX_FORWARD_TARGETS) {
      throw new ApiError(400, 'validation_failed', 'The request body is invalid', [
        { field: 'targetConversationIds', message: `must name 1 to ${MAX_FORWARD_TARGETS}` },
      ]);
    }

    await this.conversations.get(context, principal, conversationId);
    const source = await this.database.read(context, (runner) =>
      this.repository.findMessageById(runner, context, messageId),
    );
    if (!source || source.conversationId !== conversationId) {
      throw new ApiError(404, 'not_found', MESSAGES.notFound);
    }
    if (source.deletedAt !== null) {
      throw new ApiError(409, 'conflict', 'This message was deleted, so it cannot be forwarded');
    }
    const kind = source.kind as MessageKind;
    if (kind === 'system') {
      throw new ApiError(422, 'validation_failed', 'System messages cannot be forwarded');
    }

    const fileIds = (
      await this.attachments.list(context, principal, conversationId, messageId)
    ).map((item) => item.fileAssetId);
    const meta =
      kind === 'text' ? { forwardedFromMessageId: source.id } : (source.metaJson ?? undefined);

    const forwarded: { conversationId: string; messageId: string }[] = [];
    const refused: string[] = [];
    for (const target of targets) {
      try {
        const view = await this.conversations.get(context, principal, target);
        if (!(await this.mayCarryFiles(context, principal, view.projectId, fileIds))) {
          refused.push(target);
          continue;
        }
        const { message } = await this.conversations.postMessage(context, principal, target, {
          body: source.body,
          kind,
          ...(meta === undefined ? {} : { meta }),
        });
        for (const fileId of fileIds) {
          await this.attachments.attach(context, principal, target, message.id, fileId);
        }
        forwarded.push({ conversationId: target, messageId: message.id });
      } catch (error) {
        if (error instanceof ApiError && [403, 404, 409, 422].includes(error.status)) {
          refused.push(target);
          continue;
        }
        throw error;
      }
    }
    return { forwarded, refused };
  }

  /** `MessageAttachmentsService.attach`'s file gate, asked before anything is posted. */
  private async mayCarryFiles(
    context: TenantContext,
    principal: Principal,
    targetProjectId: string | null,
    fileIds: readonly string[],
  ): Promise<boolean> {
    for (const fileId of fileIds) {
      const file = await this.database.read(context, (runner) =>
        this.files.findById(runner, context, fileId),
      );
      // FIX4 item 1b: the attach door's own rule (ready, or not scanned under the owner's policy).
      if (!file || !(await this.attachments.fileUsable(context, file))) return false;
      if (file.projectId !== targetProjectId) return false;
      const verdict = authorize({
        principal,
        capability: 'file.download',
        resource: {
          organizationId: file.organizationId,
          projectId: file.projectId,
          audience: file.audience,
          clientOrganizationId: file.clientOrganizationId,
          lifecycle: 'active',
        },
      });
      if (!verdict.allowed) return false;
    }
    return true;
  }
}
