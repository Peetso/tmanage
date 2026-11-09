import { authorize, isServableVersion, SERVABLE_UPLOAD_STATES } from '@tmanage/domain';
import type { Principal, UploadState } from '@tmanage/domain';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import type {
  TenantContext,
  TenantDatabase,
  TenantQueryRunner,
} from '../../common/database/tenant-context.js';
import type { ConversationRow, FileAssetRow, MessageRow } from '../../common/database/schema.js';
import { FileAssetsRepository } from '../files/file-assets.repository.js';
import { awaitingScan, usableScanStatus } from '../files/file-download.service.js';
import {
  effectiveDownloadScanPolicyOn,
  readDownloadScanPolicy,
} from '../tenancy/download-scan-policy.js';
import type { ScannerPresence } from '../tenancy/download-scan-policy.js';
import { OrgSettingsRepository } from '../tenancy/org-settings.repository.js';
import { ConversationsRepository } from './conversations.repository.js';
import { MessageAttachmentsRepository } from './message-attachments.repository.js';
import type { AttachedFileRow } from './message-attachments.repository.js';

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

/**
 * L2 — what the virus scan says about an attached file, as the download door would treat it:
 * `clean` downloads; `not_scanned` downloads under the owner's "Allow, marked Not scanned" (the row
 * shows B5's label); `being_checked` is refused until the scan is done under "Block until scanned";
 * `unavailable` (rejected, infected or expired after it was attached) is never served.
 */
export type MessageAttachmentScanStatus = 'clean' | 'not_scanned' | 'being_checked' | 'unavailable';

/** What a caller sees of one attached file. `sizeBytes` is `null` before the file's first version. */
export interface MessageAttachmentView {
  readonly fileAssetId: string;
  readonly name: string;
  readonly sizeBytes: number | null;
  readonly attachedAt: string;
  readonly scanStatus: MessageAttachmentScanStatus;
}

/** A message resolved through the conversation gate, with the conversation it was resolved in. */
interface ResolvedMessage {
  readonly conversation: ConversationRow;
  readonly message: MessageRow;
}

/** L2 — one message's attachments in the batched read. */
export interface MessageAttachmentsOfMessage {
  readonly messageId: string;
  readonly attachments: readonly MessageAttachmentView[];
}

export class MessageAttachmentsService {
  constructor(
    private readonly database: TenantDatabase,
    private readonly attachments: MessageAttachmentsRepository = new MessageAttachmentsRepository(),
    private readonly conversations: ConversationsRepository = new ConversationsRepository(),
    private readonly files: FileAssetsRepository = new FileAssetsRepository(),
    /** L2. The configured scanner, as the download door gets it; absent means `allow_labeled`. */
    private readonly scanner?: ScannerPresence,
    private readonly settings: OrgSettingsRepository = new OrgSettingsRepository(),
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
      const { conversation, message } = await this.resolveAuthoredMessage(
        context,
        principal,
        conversationId,
        messageId,
        tx,
      );
      // F40: a taken-down message stays taken down — nothing new is published on it.
      if (message.deletedAt !== null) {
        throw new ApiError(
          409,
          'conflict',
          'This message was taken down, so nothing can be attached to it',
        );
      }
      await this.resolveReadableFile(context, principal, conversation, fileId, tx);
      const { row, created } = await this.attachments.insert(tx, context, {
        messageId,
        fileAssetId: fileId,
      });
      const listed = await this.attachments.listForMessage(tx, context, messageId);
      const found = listed.find((item) => item.fileAssetId === fileId);
      // The row was just written in this transaction, so the projection always finds it; the
      // fallback keeps the type honest without inventing a size. An attachable file is `ready`.
      const [view] = found ? await this.toViews(context, [found]) : [];
      const attachment: MessageAttachmentView = view ?? {
        fileAssetId: fileId,
        name: '',
        sizeBytes: null,
        attachedAt: row.createdAt.toISOString(),
        scanStatus: 'unavailable',
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
      const { message } = await this.resolveReadableMessage(
        context,
        principal,
        conversationId,
        messageId,
        runner,
      );
      // F40: a taken-down message withholds its attachments exactly as it withholds its body.
      if (message.deletedAt !== null) return [];
      return this.attachments.listForMessage(runner, context, messageId);
    });
    return this.toViews(context, rows);
  }

  /**
   * L2 — the attachments of several messages of one conversation in one round trip, so a channel
   * reads a page's attachment cards with one request instead of one per message. The conversation
   * gate runs once (`conversation.read`, then membership unless org-wide); ids that are not
   * messages of this conversation are dropped rather than answered, so the batch never says
   * anything about another channel's message. Answers in the order asked, a message with no
   * attachments with an empty list.
   */
  async listMany(
    context: TenantContext,
    principal: Principal,
    conversationId: string,
    messageIds: readonly string[],
  ): Promise<readonly MessageAttachmentsOfMessage[]> {
    const asked = [...new Set(messageIds)];
    const { inConversation, rows } = await this.database.read(context, async (runner) => {
      const conversation = await this.conversations.findById(runner, context, conversationId);
      if (!conversation) throw new ApiError(404, 'not_found', MESSAGES.notFound);
      await this.requireReach(context, principal, conversation, 'conversation.read', runner);
      const ids = await this.attachments.messageIdsInConversation(
        runner,
        context,
        conversationId,
        asked,
      );
      return {
        inConversation: new Set(ids),
        rows: await this.attachments.listForMessages(runner, context, ids),
      };
    });
    const views = await this.toViews(context, rows);
    return asked
      .filter((messageId) => inConversation.has(messageId))
      .map((messageId) => ({
        messageId,
        attachments: views.filter((_view, index) => rows[index]?.messageId === messageId),
      }));
  }

  /**
   * L2 — rows to views, each with its scan status, by the download door's own rules. The owner's
   * policy is read once, and only when some file is still waiting for its scan (C4's rule).
   */
  private async toViews(
    context: TenantContext,
    rows: readonly AttachedFileRow[],
  ): Promise<readonly MessageAttachmentView[]> {
    let unscanned: MessageAttachmentScanStatus | undefined;
    const views: MessageAttachmentView[] = [];
    for (const row of rows) {
      let scanStatus: MessageAttachmentScanStatus = 'unavailable';
      const version = row.latestVersion;
      if (
        version !== null &&
        isServableVersion({
          status: row.assetStatus,
          scanVerdict: version.scanVerdict,
          trustZone: version.trustZone,
        })
      ) {
        scanStatus = 'clean';
      } else if (version !== null && awaitingScan(row.assetStatus, version)) {
        unscanned ??= await this.unscannedStatus(context);
        scanStatus = unscanned;
      }
      views.push({
        fileAssetId: row.fileAssetId,
        name: row.name,
        sizeBytes: row.sizeBytes,
        attachedAt: row.attachedAt.toISOString(),
        scanStatus,
      });
    }
    return views;
  }

  /** `allow_labeled` -> `not_scanned` (downloadable, labelled); `block` -> `being_checked`. */
  private async unscannedStatus(context: TenantContext): Promise<MessageAttachmentScanStatus> {
    const policy = await readDownloadScanPolicy(
      this.database,
      context,
      this.scanner,
      this.settings,
    );
    return policy.effective === 'block' ? 'being_checked' : 'not_scanned';
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
  ): Promise<ResolvedMessage> {
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
  ): Promise<ResolvedMessage> {
    const resolved = await this.resolveMessage(
      context,
      principal,
      conversationId,
      messageId,
      'conversation.write',
      runner,
    );
    if (resolved.message.authorUserId !== principal.userId) {
      throw new ApiError(403, 'forbidden', MESSAGES.forbidden);
    }
    return resolved;
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
  ): Promise<ResolvedMessage> {
    const conversation = await this.conversations.findById(runner, context, conversationId);
    if (!conversation) throw new ApiError(404, 'not_found', MESSAGES.notFound);

    const message = await this.conversations.findMessageById(runner, context, messageId);
    if (!message || message.conversationId !== conversationId) {
      throw new ApiError(404, 'not_found', MESSAGES.notFound);
    }

    await this.requireReach(context, principal, conversation, capability, runner);
    return { conversation, message };
  }

  /**
   * The capability's resource gate (404 on denial, never 403 — the channel's existence is
   * information), then the membership relation gate unless the caller holds organization-wide
   * scope. Shared by the per-message spine and the L2 batched read.
   */
  private async requireReach(
    context: TenantContext,
    principal: Principal,
    conversation: ConversationRow,
    capability: 'conversation.read' | 'conversation.write',
    runner: TenantQueryRunner,
  ): Promise<void> {
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
        conversation.id,
        principal.userId,
      );
      if (!membership) throw new ApiError(404, 'not_found', MESSAGES.notFound);
    }
  }

  /**
   * FIX4 item 1b. Whether a file may be attached now: `ready`, or — with no scanner, or under the
   * owner's "Allow, marked Not scanned" — verified and waiting for a scan (labelled `not_scanned`).
   */
  async fileUsable(
    context: TenantContext,
    file: Pick<FileAssetRow, 'id' | 'status'>,
  ): Promise<boolean> {
    return this.database.read(context, (runner) => this.usableOn(runner, context, file));
  }

  private async usableOn(
    runner: TenantQueryRunner,
    context: TenantContext,
    file: Pick<FileAssetRow, 'id' | 'status'>,
  ): Promise<boolean> {
    if (SERVABLE_UPLOAD_STATES.includes(file.status as UploadState)) return true;
    const version = await this.files.findLatestVersion(runner, context, file.id);
    const effective = await effectiveDownloadScanPolicyOn(
      runner,
      context,
      this.scanner,
      this.settings,
    );
    return usableScanStatus(file.status, version, effective) !== null;
  }

  /**
   * Resolve the file tenant-scoped and require it to be usable (FIX4: `ready`, or awaiting a scan
   * under "Allow, marked Not scanned"). A file not in this tenant, or one
   * still in flight (draft, scanning) or rejected, is a 404 — the refusal path the unit test proves,
   * with no insert. Tenant scoping means a cross-tenant `fileId` resolves to no row at all.
   *
   * F54: the author must also be able to read the file — `authorize('file.download')` on the
   * file's **own** project, audience and client organization, the download door's rule — and the
   * file must belong to the channel's project, so an attachment never carries one project's file
   * name and size into another project's room. Every refusal is the same 404 as a missing file.
   */
  private async resolveReadableFile(
    context: TenantContext,
    principal: Principal,
    conversation: ConversationRow,
    fileId: string,
    runner: TenantQueryRunner,
  ): Promise<void> {
    const file = await this.files.findById(runner, context, fileId);
    // FIX5 item 5: a deleted file cannot be attached again (it answers like an unknown id).
    if (!file || file.deletedAt != null || !(await this.usableOn(runner, context, file))) {
      throw new ApiError(404, 'not_found', MESSAGES.notFound);
    }
    if (file.projectId !== conversation.projectId) {
      throw new ApiError(404, 'not_found', MESSAGES.notFound);
    }
    const verdict = authorize({
      principal,
      capability: 'file.download',
      resource: {
        organizationId: file.organizationId,
        projectId: file.projectId,
        audience: file.audience,
        clientOrganizationId: file.clientOrganizationId,
        lifecycle: conversation.archivedAt === null ? 'active' : 'archived',
      },
    });
    if (!verdict.allowed) throw new ApiError(404, 'not_found', MESSAGES.notFound);
  }
}
