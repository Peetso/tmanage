import { Controller, Get, Inject, Param, Res, StreamableFile } from '@nestjs/common';
import type { Principal } from '@tmanage/domain';
import { Ctx, CurrentPrincipal, RequireCapability } from '../../common/http/decorators.js';
import { ApiError } from '../../common/http/errors.js';
import { DOCUMENTS_SERVICE } from '../../common/http/tokens.js';
import type { TenantContext } from '../../common/database/tenant-context.js';
import type { DocumentsService } from './documents.service.js';
import { renderDocumentMarkdown } from './document-export.js';

/** The one method the export needs of the framework reply: set a header before the first byte. */
interface HeaderWriter {
  header(name: string, value: string): unknown;
}

/**
 * DOC export (x131) — a read-only Markdown download of a document's current version, behind
 * `doc.read`.
 *
 * A separate controller from {@link DocumentsController} rather than another method on it, so the
 * bytes response mode (a `StreamableFile`, headers set before the first byte) stays isolated from
 * the JSON reads, and so this slice's file is disjoint from the sibling docs slices. It shares the
 * `documents` base path — Nest registers routes globally, so `GET :documentId/export.md` sits beside
 * the JSON `GET :documentId` with no collision (the export route has the extra literal segment).
 *
 * ## Internal-only is the substance (Known trap)
 *
 * Documents have no client projection — `doc.read` is an internal-only capability
 * (`packages/domain/src/policies/capabilities.ts`), so `CapabilityGuard` refuses a client principal
 * (or any role whose ceiling lacks `doc.read`) with the ordinary **403** before this handler runs.
 * Widening client access would be a `12-PERMISSION-MATRIX` edit and a product decision, not this
 * export's to make.
 *
 * ## Tenant-scoped before the read; a cross-tenant id is 404, never 500
 *
 * The document is resolved through {@link DocumentsService.get}, which reads it tenant-scoped
 * **before** the relation check (x91): an unknown id, an id in another tenant, and a document in a
 * project the caller is not a member of all answer the same **404** — never a 403 that would confirm
 * the document exists, and never a foreign-key 500. The export reuses that authorized read whole and
 * only serializes its result, so it can neither widen what `get` permits nor mutate anything.
 *
 * The body is a `StreamableFile` of the Markdown, which keeps Nest in its own response mode — the
 * interceptors and the exception filter still shape everything that is not the bytes — and the
 * headers force a safe download: `attachment` so a browser saves rather than renders it, `nosniff`
 * so it is not re-typed, `private, no-store` so no shared cache keeps a copy of internal content.
 */
@Controller('v1/organizations/:orgSlug/documents')
export class DocumentExportController {
  constructor(@Inject(DOCUMENTS_SERVICE) private readonly documents: DocumentsService) {}

  @Get(':documentId/export.md')
  @RequireCapability('doc.read')
  async export(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('documentId') documentId: string,
    @Res({ passthrough: true }) reply: HeaderWriter,
  ): Promise<StreamableFile> {
    if (typeof documentId !== 'string' || documentId === '') {
      throw new ApiError(400, 'validation_failed', 'documentId is required', [
        { field: 'documentId', message: 'must be a non-empty string' },
      ]);
    }

    const document = await this.documents.get(context, principal, documentId);
    const markdown = renderDocumentMarkdown({ title: document.title, body: document.body });

    reply.header('content-type', 'text/markdown; charset=utf-8');
    reply.header('content-disposition', `attachment; filename="${downloadFilename(documentId)}"`);
    reply.header('x-content-type-options', 'nosniff');
    reply.header('cache-control', 'private, no-store');
    return new StreamableFile(Buffer.from(markdown, 'utf-8'), { type: 'text/markdown; charset=utf-8' });
  }
}

/**
 * A safe `filename` for the download, built from the document id.
 *
 * The value goes into a `Content-Disposition` header, so it must not carry a quote, a CR/LF or any
 * byte that could break the header or inject a second one. Rather than escaping, every character
 * outside a conservative filename alphabet is dropped; the id is opaque and machine-generated, so
 * what remains identifies the file without risk. An id that reduced to nothing falls back to a fixed
 * name.
 */
function downloadFilename(documentId: string): string {
  const safe = documentId.replace(/[^A-Za-z0-9._-]/g, '');
  return `${safe === '' ? 'document' : safe}.md`;
}
