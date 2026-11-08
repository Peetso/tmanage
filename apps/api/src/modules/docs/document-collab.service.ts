import { authorize } from '@tmanage/domain';
import type { Principal } from '@tmanage/domain';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import {
  CollabRefusal,
  DocumentCollabAuthority,
  type CollabCursor,
  type CollabJoin,
  type CollabPush,
  type CollabSince,
} from './document-collab.authority.js';
import type { DocumentSharingRepository } from './document-sharing.repository.js';
import type { DocumentsService } from './documents.service.js';

/**
 * Slice 53-10 — live co-editing (Figma 586:33239). The permission layer over
 * {@link DocumentCollabAuthority}: every join, poll and cursor read first reads the document
 * through `DocumentsService.get` (tenant-scoped, relation-checked, 404 when not readable), and
 * every step push, snapshot and cursor write also needs `work.create` on the document's project
 * (the relation half of `doc.write`, as `DocumentsService` does). A viewer joins read-only.
 *
 * Behind the `TMANAGE_DOC_COLLAB=on` switch, off by default: while off every route is 404 and
 * the editor keeps its single-writer autosave.
 */

export type CollabRole = 'editor' | 'viewer';

export interface CollabJoinResult extends CollabJoin {
  readonly role: CollabRole;
  readonly cursors: readonly CollabCursor[];
}

export type CollabPollResult = CollabSince & { readonly cursors: readonly CollabCursor[] };

export class DocumentCollabService {
  constructor(
    private readonly database: TenantDatabase,
    private readonly documents: Pick<DocumentsService, 'get' | 'saveVersion'>,
    private readonly people: Pick<DocumentSharingRepository, 'people'>,
    private readonly enabled: boolean,
    private readonly authority: DocumentCollabAuthority = new DocumentCollabAuthority(),
  ) {}

  async join(
    context: TenantContext,
    principal: Principal,
    documentId: string,
  ): Promise<CollabJoinResult> {
    const role = await this.roleOf(context, principal, documentId);
    const key = keyOf(context, documentId);
    return {
      ...this.authority.join(key, context.userId),
      role,
      cursors: this.authority.cursors(key),
    };
  }

  async poll(
    context: TenantContext,
    principal: Principal,
    documentId: string,
    since: number,
  ): Promise<CollabPollResult> {
    await this.roleOf(context, principal, documentId);
    const key = keyOf(context, documentId);
    return { ...this.authority.since(key, since), cursors: this.authority.cursors(key) };
  }

  async push(
    context: TenantContext,
    principal: Principal,
    documentId: string,
    input: { readonly version: number; readonly clientId: string; readonly steps: unknown[] },
  ): Promise<CollabPush> {
    await this.requireEditor(context, principal, documentId);
    try {
      return this.authority.push(
        keyOf(context, documentId),
        input.version,
        input.clientId,
        input.steps,
      );
    } catch (error) {
      if (!(error instanceof CollabRefusal)) throw error;
      throw new ApiError(400, 'validation_failed', 'The request body is invalid', [
        { field: 'steps', message: error.reason },
      ]);
    }
  }

  /** Save the document at `version` as a normal version, then make it the session's base. */
  async snapshot(
    context: TenantContext,
    principal: Principal,
    documentId: string,
    input: { readonly version: number; readonly html: string; readonly orgSlug: string },
  ): Promise<{ readonly saved: boolean; readonly version: number }> {
    await this.requireEditor(context, principal, documentId);
    const key = keyOf(context, documentId);
    const current = this.authority.since(key, input.version);
    if (current.kind !== 'steps' || current.steps.length > 0) {
      return { saved: false, version: current.version };
    }
    await this.documents.saveVersion(context, principal, documentId, input.html, {
      format: 'html',
      orgSlug: input.orgSlug,
    });
    const saved = this.authority.snapshot(key, input.version, input.html);
    return { saved, version: input.version };
  }

  async cursor(
    context: TenantContext,
    principal: Principal,
    documentId: string,
    input: { readonly clientId: string; readonly anchor: number; readonly head: number },
  ): Promise<void> {
    await this.requireEditor(context, principal, documentId);
    this.authority.setCursor(keyOf(context, documentId), {
      userId: context.userId,
      clientId: input.clientId,
      name: await this.nameOf(context),
      anchor: input.anchor,
      head: input.head,
    });
  }

  private async roleOf(
    context: TenantContext,
    principal: Principal,
    documentId: string,
  ): Promise<CollabRole> {
    if (!this.enabled) {
      throw new ApiError(404, 'not_found', MESSAGES.notFound, undefined, 'doc_collab_off');
    }
    const view = await this.documents.get(context, principal, documentId);
    const writable = authorize({
      principal,
      capability: 'work.create',
      resource: {
        organizationId: context.organizationId,
        projectId: view.projectId,
        audience: 'internal',
        lifecycle: 'active',
      },
    }).allowed;
    return writable ? 'editor' : 'viewer';
  }

  private async requireEditor(
    context: TenantContext,
    principal: Principal,
    documentId: string,
  ): Promise<void> {
    const role = await this.roleOf(context, principal, documentId);
    if (role !== 'editor') {
      throw new ApiError(403, 'forbidden', MESSAGES.forbidden, undefined, 'doc_collab_read_only');
    }
  }

  private async nameOf(context: TenantContext): Promise<string> {
    const rows = await this.database.read(context, (runner) =>
      this.people.people(runner, context, { membershipIds: [context.membershipId] }),
    );
    return rows[0]?.displayName ?? '';
  }
}

function keyOf(context: TenantContext, documentId: string): string {
  return `${context.organizationId}:${documentId}`;
}
