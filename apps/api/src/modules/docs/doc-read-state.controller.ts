import { Controller, Delete, Get, HttpCode, Inject, Param, Put, Query } from '@nestjs/common';
import type { Principal } from '@tmanage/domain';
import { Ctx, CurrentPrincipal, RequireCapability } from '../../common/http/decorators.js';
import { ApiError } from '../../common/http/errors.js';
import type { TenantContext } from '../../common/database/tenant-context.js';
import type { DocReadStateService, DocReadStateView } from './doc-read-state.service.js';

/**
 * DOC read state (x297). Mark a document read (PUT), mark it unread (DELETE), and batch-read the caller's
 * read state for a set of documents (GET). Like every tenant-scoped controller here it never reads
 * `organizationId` (or the acting membership) from the body, a header, or its `:orgSlug` segment: it
 * receives the `TenantContext` that `TenantContextGuard` built from a membership row and passes it on.
 * Every route is `doc.read` — a member marks read a document they may read.
 *
 * The per-document toggle lives under `documents/:documentId/read`; the caller's batch read lives at the
 * distinct top-level `document-read-state` so it can never be matched as `documents/:documentId`.
 *
 * The service token is defined here (not in the shared `tokens.ts`) and consumed by `DocsModule`, the
 * `BookmarksModule` posture, so this slice touches no file another docs slice appends to beyond the
 * module's own controller/provider lists.
 */
export const DOC_READ_STATE_SERVICE = Symbol.for('tmanage.DocReadStateService');

@Controller('v1/organizations/:orgSlug/documents/:documentId/read')
export class DocumentReadStateController {
  constructor(@Inject(DOC_READ_STATE_SERVICE) private readonly readState: DocReadStateService) {}

  /** Mark this document read for the caller now. Idempotent: a repeated PUT refreshes the timestamp (200). */
  @Put()
  @RequireCapability('doc.read')
  async markRead(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('documentId') documentId: string,
  ): Promise<DocReadStateView> {
    requireDocumentId(documentId);
    return this.readState.markRead(context, principal, documentId);
  }

  /** Mark this document unread for the caller. Idempotent: no read state is still 204. */
  @Delete()
  @RequireCapability('doc.read')
  @HttpCode(204)
  async markUnread(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('documentId') documentId: string,
  ): Promise<void> {
    requireDocumentId(documentId);
    await this.readState.markUnread(context, principal, documentId);
  }
}

@Controller('v1/organizations/:orgSlug/document-read-state')
export class MyDocReadStateController {
  constructor(@Inject(DOC_READ_STATE_SERVICE) private readonly readState: DocReadStateService) {}

  /**
   * The caller's read state for the documents named in `?docIds=` (comma-separated). Returns only rows
   * the caller's membership owns; a document with no read state is simply absent. Missing/empty query
   * yields an empty list, never all rows.
   */
  @Get()
  @RequireCapability('doc.read')
  async batch(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Query('docIds') docIds?: string,
  ): Promise<{ readonly readStates: readonly DocReadStateView[] }> {
    const ids = parseDocIds(docIds);
    return { readStates: await this.readState.batch(context, principal, ids) };
  }
}

/** A path `documentId` is always required and always a non-empty string. */
function requireDocumentId(documentId: unknown): asserts documentId is string {
  if (typeof documentId !== 'string' || documentId === '') {
    throw new ApiError(400, 'validation_failed', 'documentId is required', [
      { field: 'documentId', message: 'must be a non-empty string' },
    ]);
  }
}

/** Split a comma-separated `docIds` query value into trimmed non-empty ids; absent → empty list. */
function parseDocIds(raw: string | undefined): readonly string[] {
  if (typeof raw !== 'string' || raw === '') {
    return [];
  }
  return raw
    .split(',')
    .map((id) => id.trim())
    .filter((id) => id !== '');
}
