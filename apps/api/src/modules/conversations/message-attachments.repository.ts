import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { uuidv7 } from '@tmanage/domain';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import { unwrapQueryError } from '../../common/database/query-error.js';
import {
  fileAssets,
  fileVersions,
  messageAttachments,
  messages,
} from '../../common/database/schema.js';
import type { FileVersionRow, MessageAttachmentRow } from '../../common/database/schema.js';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';

/** MySQL's duplicate-key error. */
const ER_DUP_ENTRY = 'ER_DUP_ENTRY';

/**
 * The driver's own error code, unwrapped first — `ConversationsRepository` records why Drizzle
 * hides it on `cause` inside a transaction. A concurrent attach that loses the unique-key race
 * reaches here as this code, not a 500.
 */
function driverErrorCode(error: unknown): string | undefined {
  const unwrapped = unwrapQueryError(error);
  if (typeof unwrapped !== 'object' || unwrapped === null) return undefined;
  const candidate = unwrapped as { code?: unknown };
  return typeof candidate.code === 'string' ? candidate.code : undefined;
}

/**
 * One attachment, joined to the file it names. `name` is the file's own name; `sizeBytes` is its
 * latest version's provider-counted size, `null` before the first completed version. The
 * `objectKey` is never projected — `FORBIDDEN_CLIENT_FIELDS` names it and it never leaves the API.
 */
export interface AttachedFileRow {
  readonly attachmentId: string;
  /** L2: the message the file is attached to — the batched read groups by it. */
  readonly messageId: string;
  readonly fileAssetId: string;
  readonly name: string;
  readonly sizeBytes: number | null;
  readonly attachedAt: Date;
  /** L2: the asset's upload state and its latest version, which together give the scan status. */
  readonly assetStatus: string;
  readonly latestVersion: FileVersionRow | null;
}

/**
 * x275's data half — the message-to-file links, and the idempotent attach/detach.
 *
 * Every method is tenant-scoped by `organization_id = context.organizationId`. The insert takes
 * the membership from the context, never from input, and the composite foreign keys bind both the
 * message and the file to the same tenant — a cross-tenant id has no referenced row and the write
 * fails closed rather than linking a foreign row. The service resolves the file (tenant-scoped and
 * `ready`) before it ever reaches the insert, so the refusal path is a 404 with no write.
 */
export class MessageAttachmentsRepository {
  /** The existing link of this file to this message, if any — the idempotency probe. */
  async findAttachment(
    runner: TenantQueryRunner,
    context: TenantContext,
    messageId: string,
    fileAssetId: string,
  ): Promise<MessageAttachmentRow | undefined> {
    const rows = await tenantDrizzle(runner)
      .select()
      .from(messageAttachments)
      .where(
        and(
          eq(messageAttachments.organizationId, context.organizationId),
          eq(messageAttachments.messageId, messageId),
          eq(messageAttachments.fileAssetId, fileAssetId),
        ),
      )
      .limit(1);
    return rows[0];
  }

  /**
   * Attach a file to a message, idempotently. The id, tenant and attaching membership come from the
   * context, never from input. A concurrent attach that loses the unique-key race is handed the row
   * that won rather than a 500 — "make sure this file is attached" is what the caller wants and a
   * duplicate is not an error worth making them handle.
   */
  async insert(
    runner: TenantQueryRunner,
    context: TenantContext,
    input: { readonly messageId: string; readonly fileAssetId: string },
  ): Promise<{ readonly row: MessageAttachmentRow; readonly created: boolean }> {
    const existing = await this.findAttachment(runner, context, input.messageId, input.fileAssetId);
    if (existing) return { row: existing, created: false };

    try {
      await tenantDrizzle(runner)
        .insert(messageAttachments)
        .values({
          id: uuidv7(),
          organizationId: context.organizationId,
          messageId: input.messageId,
          fileAssetId: input.fileAssetId,
          attachedByMembershipId: context.membershipId,
          createdAt: sql`current_timestamp(3)`,
        });
    } catch (error) {
      if (driverErrorCode(error) === ER_DUP_ENTRY) {
        const raced = await this.findAttachment(
          runner,
          context,
          input.messageId,
          input.fileAssetId,
        );
        if (raced) return { row: raced, created: false };
      }
      throw error;
    }

    const created = await this.findAttachment(runner, context, input.messageId, input.fileAssetId);
    if (!created) throw new Error('message_attachments row vanished immediately after insert');
    return { row: created, created: true };
  }

  /**
   * Detach a file from a message. Idempotent — a link that does not exist removes nothing and the
   * service still answers 204, because DELETE is idempotent and "it is not attached" is the state
   * the caller asked for.
   */
  async deleteLink(
    runner: TenantQueryRunner,
    context: TenantContext,
    messageId: string,
    fileAssetId: string,
  ): Promise<boolean> {
    const result = await tenantDrizzle(runner)
      .delete(messageAttachments)
      .where(
        and(
          eq(messageAttachments.organizationId, context.organizationId),
          eq(messageAttachments.messageId, messageId),
          eq(messageAttachments.fileAssetId, fileAssetId),
        ),
      );
    return result[0].affectedRows > 0;
  }

  /**
   * L2 (batched read): which of `messageIds` are messages of `conversationId` in this studio. The
   * batched list answers only for these, so an id from another channel is dropped, never listed.
   */
  async messageIdsInConversation(
    runner: TenantQueryRunner,
    context: TenantContext,
    conversationId: string,
    messageIds: readonly string[],
  ): Promise<readonly string[]> {
    if (messageIds.length === 0) return [];
    const rows = await tenantDrizzle(runner)
      .select({ id: messages.id })
      .from(messages)
      .where(
        and(
          eq(messages.organizationId, context.organizationId),
          eq(messages.conversationId, conversationId),
          inArray(messages.id, [...messageIds]),
        ),
      );
    return rows.map((row) => row.id);
  }

  /**
   * A message's attachments, oldest first, each with the file's name and its latest version's size.
   * The join to `file_assets` gives the file; the correlated `max(version_no)` join to
   * `file_versions` gives the size, `null` before the first completed version — the same latest-
   * version shape `FileAssetsRepository.findWithLatestVersion` uses.
   */
  async listForMessage(
    runner: TenantQueryRunner,
    context: TenantContext,
    messageId: string,
  ): Promise<readonly AttachedFileRow[]> {
    return this.listForMessages(runner, context, [messageId]);
  }

  /**
   * L2 — the attachments of several messages in one query, message by message, oldest first. The
   * caller has already narrowed `messageIds` to messages of one conversation it may read.
   */
  async listForMessages(
    runner: TenantQueryRunner,
    context: TenantContext,
    messageIds: readonly string[],
  ): Promise<readonly AttachedFileRow[]> {
    if (messageIds.length === 0) return [];
    const rows = await tenantDrizzle(runner)
      .select({
        attachmentId: messageAttachments.id,
        messageId: messageAttachments.messageId,
        fileAssetId: fileAssets.id,
        name: fileAssets.name,
        assetStatus: fileAssets.status,
        attachedAt: messageAttachments.createdAt,
        latestVersion: fileVersions,
      })
      .from(messageAttachments)
      .innerJoin(
        fileAssets,
        and(
          eq(fileAssets.organizationId, messageAttachments.organizationId),
          eq(fileAssets.id, messageAttachments.fileAssetId),
        ),
      )
      .leftJoin(
        fileVersions,
        and(
          eq(fileVersions.organizationId, fileAssets.organizationId),
          eq(fileVersions.fileAssetId, fileAssets.id),
          eq(
            fileVersions.versionNo,
            sql`(select max(l.version_no) from file_versions l where l.organization_id = ${fileAssets.organizationId} and l.file_asset_id = ${fileAssets.id})`,
          ),
        ),
      )
      .where(
        and(
          eq(messageAttachments.organizationId, context.organizationId),
          inArray(messageAttachments.messageId, [...messageIds]),
        ),
      )
      .orderBy(asc(messageAttachments.createdAt), asc(messageAttachments.id));

    return rows.map((row) => {
      const size = row.latestVersion?.sizeBytes;
      return {
        attachmentId: row.attachmentId,
        messageId: row.messageId,
        fileAssetId: row.fileAssetId,
        name: row.name,
        sizeBytes: size === null || size === undefined ? null : Number(size),
        attachedAt: row.attachedAt,
        assetStatus: row.assetStatus,
        latestVersion: row.latestVersion ?? null,
      };
    });
  }
}
