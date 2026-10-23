import { authorize } from '@tmanage/domain';
import type { Capability, Principal } from '@tmanage/domain';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import type {
  TenantContext,
  TenantDatabase,
  TenantQueryRunner,
} from '../../common/database/tenant-context.js';
import type { ClientRequestRow, RequestMessageRow } from '../../common/database/schema.js';
import type { OutboxEventsRepository } from '../platform/outbox-events.repository.js';
import type { ClientRequestsRepository } from './client-requests.repository.js';
import { audienceOf } from './client-requests.service.js';
import {
  MAX_REQUEST_MESSAGE_FILES,
  RequestMessagesRepository,
  type RequestMessageFileEntry,
} from './request-messages.repository.js';

/**
 * The client <-> studio thread on a client request (0212, audit gap 4) — the application service.
 *
 * Two doors, as `ClientRequestsService` has: the team reads and writes under
 * `client_request.triage` (internal-only), a client under `client_request.submit` on their own
 * request. Each door resolves the request inside the acting tenant FIRST, then asks `authorize()`
 * about that row — an absent, cross-tenant, sibling-client or unshared request is the same 404 with
 * no write. The client door selects `client_visible = 1` only, posts client-visible always, and
 * returns {@link RequestMessageClientView}, which has no staff identity on it. Every post appends
 * `client_request.message_posted.v1` to the outbox in the same transaction (ids only, no body).
 */

/** Injection token, local to this module. */
export const REQUEST_MESSAGES_SERVICE = Symbol('REQUEST_MESSAGES_SERVICE');

/** `request_messages.body` is TEXT; this bounds one message. */
export const MAX_REQUEST_MESSAGE_LENGTH = 5000;

export { MAX_REQUEST_MESSAGE_FILES };

/** What a message carries, on either side. */
export interface PostRequestMessageInput {
  readonly body: string;
  /** A8: ids of `request_attachment` uploads on this request (0221). */
  readonly fileIds?: readonly string[] | undefined;
}

interface Attachment {
  readonly id: string;
  readonly name: string;
}

/** The team's projection: every message, with its author and visibility. */
export interface RequestMessageView {
  readonly id: string;
  readonly requestId: string;
  readonly authorMembershipId: string;
  readonly authorKind: 'internal' | 'client';
  readonly body: string;
  readonly clientVisible: boolean;
  readonly createdAt: string;
  /** A8: the author's display name, or null when the membership no longer resolves. */
  readonly authorName: string | null;
  /** A8 (0221): the files attached to this message. */
  readonly files: readonly { readonly id: string; readonly name: string }[];
}

/** The client's projection: client-visible messages only, the studio as one voice. */
export interface RequestMessageClientView {
  readonly id: string;
  readonly requestId: string;
  readonly from: 'studio' | 'client';
  readonly mine: boolean;
  readonly body: string;
  readonly createdAt: string;
  /** A8: who wrote it — the portal card names the studio person and the client person. */
  readonly authorName: string | null;
  /** A8 (0221): the files attached to this message. */
  readonly files: readonly { readonly id: string; readonly name: string }[];
}

type Door = 'internal' | 'client';

export class RequestMessagesService {
  constructor(
    private readonly database: TenantDatabase,
    private readonly requests: ClientRequestsRepository,
    private readonly messages: RequestMessagesRepository = new RequestMessagesRepository(),
    /** Optional so a unit test can construct the service without one; the app always wires it. */
    private readonly outbox?: OutboxEventsRepository,
  ) {}

  async listForTeam(
    context: TenantContext,
    principal: Principal,
    requestId: string,
  ): Promise<readonly RequestMessageView[]> {
    return this.database.read(context, async (runner) => {
      await this.resolve(runner, context, principal, requestId, 'internal');
      const rows = await this.messages.listForRequest(runner, context, requestId, false);
      const extras = await this.extras(runner, context, requestId, rows);
      return rows.map((row) => toTeamView(row, extras.names, extras.files));
    });
  }

  async postForTeam(
    context: TenantContext,
    principal: Principal,
    requestId: string,
    input: PostRequestMessageInput & { readonly clientVisible: boolean },
  ): Promise<RequestMessageView> {
    const posted = await this.post(context, principal, requestId, 'internal', input);
    return toTeamView(posted.row, posted.names, posted.files);
  }

  async listForClient(
    context: TenantContext,
    principal: Principal,
    requestId: string,
  ): Promise<readonly RequestMessageClientView[]> {
    return this.database.read(context, async (runner) => {
      await this.resolve(runner, context, principal, requestId, 'client');
      const rows = await this.messages.listForRequest(runner, context, requestId, true);
      const extras = await this.extras(runner, context, requestId, rows);
      return rows.map((row) => toClientView(row, principal, extras.names, extras.files));
    });
  }

  async postForClient(
    context: TenantContext,
    principal: Principal,
    requestId: string,
    input: PostRequestMessageInput,
  ): Promise<RequestMessageClientView> {
    // A client cannot write a note the client cannot see (also a CHECK in 0212).
    const posted = await this.post(context, principal, requestId, 'client', {
      body: input.body,
      fileIds: input.fileIds,
      clientVisible: true,
    });
    return toClientView(posted.row, principal, posted.names, posted.files);
  }

  /** A8: author names and attachments for a page of rows, in two reads. */
  private async extras(
    runner: TenantQueryRunner,
    context: TenantContext,
    requestId: string,
    rows: readonly RequestMessageRow[],
  ): Promise<{
    readonly names: ReadonlyMap<string, string>;
    readonly files: ReadonlyMap<string, readonly Attachment[]>;
  }> {
    if (rows.length === 0) return { names: new Map(), files: new Map() };
    const names = await this.messages.authorNames(
      runner,
      context,
      rows.map((row) => row.authorMembershipId),
    );
    const entries = await this.messages.listFilesForRequest(runner, context, requestId);
    return { names, files: groupFiles(entries) };
  }

  private async post(
    context: TenantContext,
    principal: Principal,
    requestId: string,
    door: Door,
    input: PostRequestMessageInput & { readonly clientVisible: boolean },
  ): Promise<{
    readonly row: RequestMessageRow;
    readonly names: ReadonlyMap<string, string>;
    readonly files: ReadonlyMap<string, readonly Attachment[]>;
  }> {
    return this.database.transaction(context, async (tx) => {
      const request = await this.resolve(tx, context, principal, requestId, door);
      if (!principal.membershipId) {
        throw new ApiError(403, 'forbidden', MESSAGES.forbidden);
      }
      const fileIds = [...new Set(input.fileIds ?? [])];
      if (fileIds.length > MAX_REQUEST_MESSAGE_FILES) {
        throw invalidFiles(`must name ${MAX_REQUEST_MESSAGE_FILES} files or fewer`);
      }
      // Every named file must be an upload on THIS request (and, for a client, their own) —
      // one that is not refuses the whole post, before anything is written.
      const attachable = await this.messages.findAttachableFiles(tx, context, {
        requestId: request.id,
        fileIds,
        clientOrganizationId: door === 'client' ? principal.clientOrganizationId : null,
      });
      if (attachable.length !== fileIds.length) {
        throw invalidFiles('must name files uploaded to this request');
      }
      const row = await this.messages.create(tx, context, {
        requestId: request.id,
        authorMembershipId: principal.membershipId,
        authorKind: door,
        body: input.body,
        clientVisible: input.clientVisible,
      });
      await this.messages.attachFiles(tx, context, {
        messageId: row.id,
        requestId: request.id,
        fileAssetIds: attachable.map((file) => file.id),
        attachedByMembershipId: principal.membershipId,
      });
      await this.outbox?.append(tx, context, {
        type: 'client_request.message_posted.v1',
        aggregateId: request.id,
        payload: {
          requestId: request.id,
          messageId: row.id,
          projectId: request.projectId,
          clientOrganizationId: request.clientOrganizationId,
          authorMembershipId: row.authorMembershipId,
          authorKind: door,
          clientVisible: row.clientVisible,
        },
      });
      const names = await this.messages.authorNames(tx, context, [row.authorMembershipId]);
      return { row, names, files: new Map([[row.id, attachable]]) };
    });
  }

  /**
   * Read the request tenant-scoped, then authorize this principal on it through the right door.
   * Absent and not-yours are the same 404, so a caller cannot discover a request by messaging it.
   */
  private async resolve(
    runner: TenantQueryRunner,
    context: TenantContext,
    principal: Principal,
    requestId: string,
    door: Door,
  ): Promise<ClientRequestRow> {
    if (door === 'client' && (principal.kind !== 'client' || !principal.clientOrganizationId)) {
      throw new ApiError(403, 'forbidden', MESSAGES.forbidden);
    }
    const row = await this.requests.findById(runner, context, requestId);
    if (!row) throw new ApiError(404, 'not_found', MESSAGES.notFound);
    const capability: Capability =
      door === 'client' ? 'client_request.submit' : 'client_request.triage';
    const verdict = authorize({
      principal,
      capability,
      resource: {
        organizationId: row.organizationId,
        projectId: row.projectId,
        audience: door === 'client' ? audienceOf(row) : 'internal',
        clientOrganizationId: row.clientOrganizationId,
        lifecycle: 'active',
      },
    });
    if (!verdict.allowed) throw new ApiError(404, 'not_found', MESSAGES.notFound);
    return row;
  }
}

function invalidFiles(message: string): ApiError {
  return new ApiError(422, 'validation_failed', 'The request body is invalid', [
    { field: 'fileIds', message },
  ]);
}

function groupFiles(
  entries: readonly RequestMessageFileEntry[],
): ReadonlyMap<string, readonly Attachment[]> {
  const grouped = new Map<string, Attachment[]>();
  for (const entry of entries) {
    const list = grouped.get(entry.messageId) ?? [];
    list.push({ id: entry.fileAssetId, name: entry.name });
    grouped.set(entry.messageId, list);
  }
  return grouped;
}

function toTeamView(
  row: RequestMessageRow,
  names: ReadonlyMap<string, string>,
  files: ReadonlyMap<string, readonly Attachment[]>,
): RequestMessageView {
  return {
    id: row.id,
    requestId: row.requestId,
    authorMembershipId: row.authorMembershipId,
    authorKind: row.authorKind,
    body: row.body,
    clientVisible: row.clientVisible,
    createdAt: row.createdAt.toISOString(),
    authorName: names.get(row.authorMembershipId) ?? null,
    files: files.get(row.id) ?? [],
  };
}

function toClientView(
  row: RequestMessageRow,
  principal: Principal,
  names: ReadonlyMap<string, string>,
  files: ReadonlyMap<string, readonly Attachment[]>,
): RequestMessageClientView {
  return {
    id: row.id,
    requestId: row.requestId,
    from: row.authorKind === 'client' ? 'client' : 'studio',
    mine: row.authorMembershipId === principal.membershipId,
    body: row.body,
    createdAt: row.createdAt.toISOString(),
    authorName: names.get(row.authorMembershipId) ?? null,
    files: files.get(row.id) ?? [],
  };
}
