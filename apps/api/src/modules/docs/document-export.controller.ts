import { Controller, Get, Inject, Param, Res, StreamableFile } from '@nestjs/common';
import type { Principal } from '@tmanage/domain';
import { Ctx, CurrentPrincipal, RequireCapability } from '../../common/http/decorators.js';
import { ApiError } from '../../common/http/errors.js';
import { DOCUMENTS_SERVICE } from '../../common/http/tokens.js';
import type { TenantContext } from '../../common/database/tenant-context.js';
import type { DocumentsService } from './documents.service.js';
import { renderDocumentMarkdown } from './document-export.js';
import { renderDocumentDocx } from './document-export-docx.js';
import { renderDocumentHtml, type DocumentBodyFormat } from './document-export-html.js';

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
    const document = await this.load(context, principal, documentId);
    const markdown = renderDocumentMarkdown(document);
    return download(
      reply,
      Buffer.from(markdown, 'utf-8'),
      MARKDOWN,
      contentDisposition(document, documentId, 'md'),
    );
  }

  /** R5 export: a standalone HTML page (inline CSS, `dir` by the first strong character). */
  @Get(':documentId/export.html')
  @RequireCapability('doc.read')
  async exportHtml(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('documentId') documentId: string,
    @Res({ passthrough: true }) reply: HeaderWriter,
  ): Promise<StreamableFile> {
    const document = await this.load(context, principal, documentId);
    const html = renderDocumentHtml(document);
    return download(
      reply,
      Buffer.from(html, 'utf-8'),
      HTML,
      contentDisposition(document, documentId, 'html'),
    );
  }

  /** R5 export: a Word file built in-process with the MIT `docx` package. */
  @Get(':documentId/export.docx')
  @RequireCapability('doc.read')
  async exportDocx(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('documentId') documentId: string,
    @Res({ passthrough: true }) reply: HeaderWriter,
  ): Promise<StreamableFile> {
    const document = await this.load(context, principal, documentId);
    const bytes = await renderDocumentDocx(document);
    return download(reply, bytes, DOCX, contentDisposition(document, documentId, 'docx'));
  }

  /** The one authorized read every export shares: tenant-scoped `DocumentsService.get`. */
  private async load(
    context: TenantContext,
    principal: Principal,
    documentId: string,
  ): Promise<{ title: string; body: string; bodyFormat: DocumentBodyFormat }> {
    if (typeof documentId !== 'string' || documentId === '') {
      throw new ApiError(400, 'validation_failed', 'documentId is required', [
        { field: 'documentId', message: 'must be a non-empty string' },
      ]);
    }
    const document = await this.documents.get(context, principal, documentId);
    return { title: document.title, body: document.body, bodyFormat: document.bodyFormat };
  }
}

const MARKDOWN = 'text/markdown; charset=utf-8';
const HTML = 'text/html; charset=utf-8';
const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

/** Set the safe-download headers and hand Nest the bytes. */
function download(
  reply: HeaderWriter,
  bytes: Buffer,
  type: string,
  disposition: string,
): StreamableFile {
  reply.header('content-type', type);
  reply.header('content-disposition', disposition);
  reply.header('x-content-type-options', 'nosniff');
  reply.header('cache-control', 'private, no-store');
  return new StreamableFile(bytes, { type });
}

/**
 * The `Content-Disposition` for a download, shared by every export format.
 *
 * The value goes into a header, so the plain `filename` keeps only a conservative ASCII alphabet
 * (no quote, CR/LF or byte that could break the header or inject a second one): the title's ASCII
 * letters, digits, `.`, `_` and `-`, spaces folded to `-`, falling back to the opaque document id.
 * The real title — Arabic included — rides in RFC 5987 `filename*=UTF-8''…`, percent-encoded
 * (every byte outside the RFC's attr-char set, `'()*` too), which modern browsers prefer.
 */
export function contentDisposition(
  document: { title: string },
  documentId: string,
  extension: string,
): string {
  // Control characters (C0 + DEL) and path separators become spaces.
  const title = Array.from(document.title, (char) =>
    char.charCodeAt(0) < 0x20 || char.charCodeAt(0) === 0x7f || char === '/' || char === '\\'
      ? ' '
      : char,
  )
    .join('')
    .trim()
    .slice(0, 120);
  const ascii = title
    .replace(/\s+/gu, '-')
    .replace(/[^A-Za-z0-9._-]/g, '')
    .replace(/^[.-]+/u, '');
  const id = documentId.replace(/[^A-Za-z0-9._-]/g, '');
  const fallback = ascii !== '' ? ascii : id !== '' ? id : 'document';
  const encoded = encodeURIComponent(title === '' ? fallback : title).replace(
    /['()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `attachment; filename="${fallback}.${extension}"; filename*=UTF-8''${encoded}.${extension}`;
}
