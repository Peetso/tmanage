import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { uuidv7 } from '@tmanage/domain';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import {
  clientMemberships,
  fileAssets,
  memberships,
  requestMessageFiles,
  requestMessages,
  users,
} from '../../common/database/schema.js';
import type { RequestMessageRow } from '../../common/database/schema.js';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';
import { REQUEST_MESSAGE_FILE_PURPOSES } from '../files/purpose-policy.js';

/**
 * Request messages — the storage half of the client <-> studio thread (0212, audit gap 4).
 *
 * `RequestCommentsRepository`'s shape: `TenantContext` scopes every read and write, no input type
 * carries an `organizationId`, and there is no policy here. Append-only: insert and read, no update
 * or delete — mirroring the INSERT-only grant in `users.sql` and the 0212 trigger.
 */

/** The largest page a single read returns. */
export const MAX_REQUEST_MESSAGE_PAGE = 500;

export interface CreateRequestMessageInput {
  readonly requestId: string;
  readonly authorMembershipId: string;
  readonly authorKind: 'internal' | 'client';
  readonly body: string;
  readonly clientVisible: boolean;
}

/** A8. The most files one message may carry. */
export const MAX_REQUEST_MESSAGE_FILES = 10;

/**
 * A8. The upload states a file may be attached in: the bytes have arrived and the verifier and
 * scanner may still be working. A rejected, expired or cancelled upload is never attachable.
 */
const ATTACHABLE_UPLOAD_STATES = ['uploaded', 'verifying', 'scanning', 'ready'] as const;

/** One attachment as the thread draws it. */
export interface RequestMessageFileEntry {
  readonly messageId: string;
  readonly fileAssetId: string;
  readonly name: string;
}

export class RequestMessagesRepository {
  /**
   * The request's messages, oldest first. `clientVisibleOnly` is a query predicate — the client
   * read never selects a team-only row, rather than dropping it after the fact.
   */
  async listForRequest(
    runner: TenantQueryRunner,
    context: TenantContext,
    requestId: string,
    clientVisibleOnly: boolean,
  ): Promise<readonly RequestMessageRow[]> {
    const scope = and(
      eq(requestMessages.organizationId, context.organizationId),
      eq(requestMessages.requestId, requestId),
      // PA-03 (0245): a soft-deleted message leaves the thread.
      isNull(requestMessages.deletedAt),
    );
    return tenantDrizzle(runner)
      .select()
      .from(requestMessages)
      .where(clientVisibleOnly ? and(scope, eq(requestMessages.clientVisible, true)) : scope)
      .orderBy(asc(requestMessages.createdAt), asc(requestMessages.id))
      .limit(MAX_REQUEST_MESSAGE_PAGE);
  }

  /** Append a message; the server timestamp is read back rather than reconstructed. */
  async create(
    runner: TenantQueryRunner,
    context: TenantContext,
    input: CreateRequestMessageInput,
  ): Promise<RequestMessageRow> {
    const id = uuidv7();
    const db = tenantDrizzle(runner);
    await db.insert(requestMessages).values({
      id,
      organizationId: context.organizationId,
      requestId: input.requestId,
      authorMembershipId: input.authorMembershipId,
      authorKind: input.authorKind,
      body: input.body,
      clientVisible: input.clientVisible,
      createdAt: sql`current_timestamp(3)`,
    });
    const rows = await db
      .select()
      .from(requestMessages)
      .where(
        and(eq(requestMessages.organizationId, context.organizationId), eq(requestMessages.id, id)),
      )
      .limit(1);
    const created = rows[0];
    if (!created) {
      // Unreachable: the insert above committed this row in this transaction.
      throw new Error('request message vanished immediately after insert');
    }
    return created;
  }

  /**
   * A8. Of `fileIds`, the ones that may be attached to a message on this request: a
   * `request_message` upload (0232; or a `request_attachment` one from before it) whose `objectId` is the request, in an attachable state, and —
   * when `clientOrganizationId` is given (the client door) — uploaded by that client organization.
   * The caller compares the count, so one foreign id refuses the whole post.
   */
  async findAttachableFiles(
    runner: TenantQueryRunner,
    context: TenantContext,
    input: {
      readonly requestId: string;
      readonly fileIds: readonly string[];
      readonly clientOrganizationId: string | null;
    },
  ): Promise<readonly { readonly id: string; readonly name: string }[]> {
    if (input.fileIds.length === 0) return [];
    const predicates = [
      eq(fileAssets.organizationId, context.organizationId),
      inArray(fileAssets.id, [...input.fileIds]),
      inArray(fileAssets.purpose, [...REQUEST_MESSAGE_FILE_PURPOSES]),
      eq(fileAssets.objectId, input.requestId),
      inArray(fileAssets.status, [...ATTACHABLE_UPLOAD_STATES]),
      // PA-03 (0245): a soft-deleted file cannot be attached.
      isNull(fileAssets.deletedAt),
    ];
    if (input.clientOrganizationId !== null) {
      predicates.push(eq(fileAssets.clientOrganizationId, input.clientOrganizationId));
    }
    return tenantDrizzle(runner)
      .select({ id: fileAssets.id, name: fileAssets.name })
      .from(fileAssets)
      .where(and(...predicates))
      .limit(MAX_REQUEST_MESSAGE_FILES);
  }

  /** A8. Record the files a message carries, in the post's transaction. */
  async attachFiles(
    runner: TenantQueryRunner,
    context: TenantContext,
    input: {
      readonly messageId: string;
      readonly requestId: string;
      readonly fileAssetIds: readonly string[];
      readonly attachedByMembershipId: string;
    },
  ): Promise<void> {
    if (input.fileAssetIds.length === 0) return;
    await tenantDrizzle(runner)
      .insert(requestMessageFiles)
      .values(
        input.fileAssetIds.map((fileAssetId) => ({
          id: uuidv7(),
          organizationId: context.organizationId,
          messageId: input.messageId,
          requestId: input.requestId,
          fileAssetId,
          attachedByMembershipId: input.attachedByMembershipId,
          createdAt: sql`current_timestamp(3)`,
        })),
      );
  }

  /** A8. Every attachment on the request's messages, with the file's name, oldest first. */
  async listFilesForRequest(
    runner: TenantQueryRunner,
    context: TenantContext,
    requestId: string,
  ): Promise<readonly RequestMessageFileEntry[]> {
    return tenantDrizzle(runner)
      .select({
        messageId: requestMessageFiles.messageId,
        fileAssetId: requestMessageFiles.fileAssetId,
        name: fileAssets.name,
      })
      .from(requestMessageFiles)
      .innerJoin(
        fileAssets,
        and(
          eq(fileAssets.organizationId, requestMessageFiles.organizationId),
          eq(fileAssets.id, requestMessageFiles.fileAssetId),
        ),
      )
      .where(
        and(
          eq(requestMessageFiles.organizationId, context.organizationId),
          eq(requestMessageFiles.requestId, requestId),
          // PA-03 (0245): a soft-deleted file is not listed.
          isNull(fileAssets.deletedAt),
        ),
      )
      .orderBy(asc(requestMessageFiles.createdAt), asc(requestMessageFiles.id));
  }

  /**
   * A8. The display name behind each author membership — a studio membership or a client
   * person's membership (the thread holds both). Names only, never emails.
   */
  async authorNames(
    runner: TenantQueryRunner,
    context: TenantContext,
    membershipIds: readonly string[],
  ): Promise<ReadonlyMap<string, string>> {
    const ids = [...new Set(membershipIds)];
    if (ids.length === 0) return new Map();
    const db = tenantDrizzle(runner);
    const staff = await db
      .select({ id: memberships.id, name: users.displayName })
      .from(memberships)
      .innerJoin(users, eq(users.id, memberships.userId))
      .where(
        and(eq(memberships.organizationId, context.organizationId), inArray(memberships.id, ids)),
      );
    const people = await db
      .select({ id: clientMemberships.id, name: users.displayName })
      .from(clientMemberships)
      .innerJoin(users, eq(users.id, clientMemberships.userId))
      .where(
        and(
          eq(clientMemberships.organizationId, context.organizationId),
          inArray(clientMemberships.id, ids),
        ),
      );
    return new Map([...staff, ...people].map((row) => [row.id, row.name]));
  }
}
