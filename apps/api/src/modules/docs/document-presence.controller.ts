import { Controller, Get, HttpCode, Inject, Param, Put } from '@nestjs/common';
import type { Principal } from '@tmanage/domain';
import { Ctx, CurrentPrincipal, RequireCapability } from '../../common/http/decorators.js';
import { ApiError } from '../../common/http/errors.js';
import type { TenantContext } from '../../common/database/tenant-context.js';
import type { DocumentEditorView, DocumentPresenceService } from './document-presence.service.js';

export const DOCUMENT_PRESENCE_SERVICE = Symbol.for('tmanage.DocumentPresenceService');

/**
 * R5 slice 2 — `GET|PUT …/documents/:documentId/presence` (R5-SPEC §4). `doc.read` suffices: being
 * seen in a document you can read reveals nothing new. The tenant is the guard's `TenantContext`.
 */
@Controller('v1/organizations/:orgSlug/documents/:documentId/presence')
export class DocumentPresenceController {
  constructor(
    @Inject(DOCUMENT_PRESENCE_SERVICE) private readonly presence: DocumentPresenceService,
  ) {}

  @Get()
  @RequireCapability('doc.read')
  async list(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('documentId') documentId: string,
  ): Promise<{ readonly editors: readonly DocumentEditorView[] }> {
    requireDocumentId(documentId);
    return { editors: await this.presence.list(context, principal, documentId) };
  }

  /** The heartbeat. Body `{}`; 204. */
  @Put()
  @RequireCapability('doc.read')
  @HttpCode(204)
  async touch(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('documentId') documentId: string,
  ): Promise<void> {
    requireDocumentId(documentId);
    await this.presence.touch(context, principal, documentId);
  }
}

function requireDocumentId(documentId: unknown): asserts documentId is string {
  if (typeof documentId !== 'string' || documentId === '') {
    throw new ApiError(400, 'validation_failed', 'documentId is required', [
      { field: 'documentId', message: 'must be a non-empty string' },
    ]);
  }
}
