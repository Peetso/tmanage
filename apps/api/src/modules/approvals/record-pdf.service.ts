import type { Principal } from '@tmanage/domain';
import { ObjectNotFoundError, derivativeObjectKey } from '@tmanage/storage';
import type { ObjectStore } from '@tmanage/storage';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import { ApiError } from '../../common/http/errors.js';
import { pngCodec } from '../files/preview-generators/codecs.js';
import type { ApprovalCertificateView, ApprovalsService } from './approvals.service.js';
import type { EsignService } from './esign.service.js';
import { recordPdfObjectId, renderRecordPdf } from './record-pdf.js';
import type { PdfImage } from './record-pdf.js';
import { certificatePdfDocument, signedPdfDocument } from './record-pdf-documents.js';
import type { SignedDocumentFacts } from './record-pdf-documents.js';
import { RecordPdfRepository } from './record-pdf.repository.js';

/**
 * 52-19 / 52-26 — the sealed record PDFs: the approval certificate and the signed document.
 *
 * Authorization and verification stay with the services that own them: the certificate comes from
 * {@link ApprovalsService.certificate} / `clientCertificate` (staff `approval.read` on the
 * project; a client sees only their own records on a version published to them) and the signed
 * facts from the e-sign service (staff on the project; a client only through their own signer
 * row). A record that no longer verifies is never rendered: the answer is a 409, so a PDF never
 * presents changed data as sealed.
 *
 * ## Storage
 *
 * A PDF is a pure function of the sealed records it shows, so it is stored content-addressed in
 * the `derived` zone through the existing object store: `tenant/{org}/derivative/{version}/{id}`,
 * where `id` is {@link recordPdfObjectId} of the layout version, the audience and the record
 * hashes. The staff and the portal copy of one approval differ (a client sees only their own
 * records), so they are two objects; a new decision or signature gives a new id. The first
 * download (or, for a signature, the moment it is sealed) writes it; later ones read it back.
 */

/** A stored PDF larger than this is not ours; it is regenerated instead of streamed whole. */
const MAX_PDF_BYTES = 8 * 1024 * 1024;
/** The e-sign service refuses marks over 200 KB. */
const MAX_MARK_BYTES = 256 * 1024;

export interface RecordPdfFile {
  readonly bytes: Buffer;
  /** ASCII-safe; the controller builds the header from it. */
  readonly fileName: string;
}

type Audience = 'workspace' | 'portal';

function recordChanged(): ApiError {
  return new ApiError(409, 'conflict', 'This record no longer verifies.', [
    { field: 'record', message: 'record_changed' },
  ]);
}

async function readAll(stream: NodeJS.ReadableStream, max: number): Promise<Buffer | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of stream) {
    const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : Buffer.from(chunk);
    size += buffer.length;
    if (size > max) {
      (stream as { destroy?: () => void }).destroy?.();
      return null;
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

/** The stored copy under its content key, or a fresh render written there first. */
export class RecordPdfStore {
  constructor(private readonly store: ObjectStore) {}

  async fetchOrRender(
    key: { readonly organizationId: string; readonly versionId: string; readonly id: string },
    render: () => Promise<Buffer>,
  ): Promise<Buffer> {
    const objectKey = derivativeObjectKey({
      organizationId: key.organizationId,
      fileVersionId: key.versionId,
      previewId: key.id,
    });
    try {
      const opened = await this.store.openDerivative({ objectKey });
      const stored = await readAll(opened.stream, MAX_PDF_BYTES);
      if (stored !== null && stored.length > 0) return stored;
    } catch (error) {
      if (!(error instanceof ObjectNotFoundError)) throw error;
    }
    const bytes = await render();
    await this.store.putDerivative({ objectKey, body: bytes });
    return bytes;
  }

  /** The drawn mark the e-sign service stored in the private zone, decoded for the page. */
  async mark(objectKey: string): Promise<PdfImage | null> {
    let png: Buffer | null;
    try {
      const opened = await this.store.openObject({ zone: 'private', objectKey });
      png = await readAll(opened.stream, MAX_MARK_BYTES);
    } catch (error) {
      if (error instanceof ObjectNotFoundError) return null;
      throw error;
    }
    return png === null ? null : decodeMark(png);
  }
}

/**
 * RGBA PNG → RGB pixels and an alpha plane. The mark was validated when it was signed; one that
 * cannot be decoded now leaves the page without the picture (its SHA-256 still prints).
 */
function decodeMark(png: Buffer): PdfImage | null {
  let decoded: { width: number; height: number; data: Buffer };
  try {
    decoded = pngCodec().PNG.sync.read(png);
  } catch {
    return null;
  }
  const { width, height, data } = decoded;
  const rgb = Buffer.alloc(width * height * 3);
  const alpha = Buffer.alloc(width * height);
  for (let i = 0; i < width * height; i += 1) {
    rgb[i * 3] = data[i * 4] ?? 0;
    rgb[i * 3 + 1] = data[i * 4 + 1] ?? 0;
    rgb[i * 3 + 2] = data[i * 4 + 2] ?? 0;
    alpha[i] = data[i * 4 + 3] ?? 0;
  }
  return { width, height, rgb, alpha };
}

/** 52-19 — the approval certificate as a PDF, staff or portal. */
export class ApprovalCertificatePdfService {
  constructor(
    private readonly database: TenantDatabase,
    private readonly approvals: Pick<ApprovalsService, 'certificate' | 'clientCertificate'>,
    private readonly files: RecordPdfStore,
    private readonly names: RecordPdfRepository = new RecordPdfRepository(),
  ) {}

  async workspace(
    context: TenantContext,
    principal: Principal,
    approvalId: string,
  ): Promise<RecordPdfFile> {
    const view = await this.approvals.certificate(context, principal, approvalId);
    return this.render(context, view, principal.kind === 'client' ? 'portal' : 'workspace');
  }

  async portal(
    context: TenantContext,
    principal: Principal,
    deliverableVersionId: string,
  ): Promise<RecordPdfFile> {
    const view = await this.approvals.clientCertificate(context, principal, deliverableVersionId);
    return this.render(context, view, principal.kind === 'client' ? 'portal' : 'workspace');
  }

  private async render(
    context: TenantContext,
    view: ApprovalCertificateView,
    audience: Audience,
  ): Promise<RecordPdfFile> {
    if (!view.intact || view.records.length === 0) throw recordChanged();
    const bytes = await this.files.fetchOrRender(
      {
        organizationId: context.organizationId,
        versionId: view.deliverableVersionId,
        id: recordPdfObjectId(['certificate', audience, ...view.records.map((r) => r.recordHash)]),
      },
      async () => {
        const names = await this.database.read(context, (runner) =>
          this.names.certificateNames(runner, context, {
            projectId: view.projectId,
            deliverableId: view.deliverableId,
            membershipIds: view.records.map((r) => r.evidence.approver.membershipId),
          }),
        );
        return renderRecordPdf(certificatePdfDocument(view, names));
      },
    );
    return { bytes, fileName: `approval-record-${view.approvalId}.pdf` };
  }
}

/** 52-26 — the signed document's signature pages as a PDF, staff or portal. */
export class SignedPdfService {
  constructor(
    private readonly esign: Pick<EsignService, 'signedFacts' | 'mySignedFacts' | 'sealedFacts'>,
    private readonly files: RecordPdfStore,
  ) {}

  async workspace(
    context: TenantContext,
    principal: Principal,
    requestId: string,
  ): Promise<RecordPdfFile> {
    return this.render(
      context,
      'workspace',
      await this.esign.signedFacts(context, principal, requestId),
    );
  }

  async portal(
    context: TenantContext,
    principal: Principal,
    requestId: string,
  ): Promise<RecordPdfFile> {
    return this.render(
      context,
      'portal',
      await this.esign.mySignedFacts(context, principal, requestId),
    );
  }

  /**
   * Produce and store the workspace copy right after a signature is sealed. Called once the
   * signing transaction has committed, never inside it; the e-sign service has already checked
   * the signer, so this reads the request under the same tenant context without a principal.
   */
  async produce(context: TenantContext, requestId: string): Promise<void> {
    await this.render(context, 'workspace', await this.esign.sealedFacts(context, requestId));
  }

  private async render(
    context: TenantContext,
    audience: Audience,
    facts: SignedDocumentFacts | 'not_signed' | 'record_changed',
  ): Promise<RecordPdfFile> {
    if (facts === 'record_changed') throw recordChanged();
    if (facts === 'not_signed') {
      throw new ApiError(409, 'conflict', 'Nobody has signed this document yet.', [
        { field: 'request', message: 'not_signed' },
      ]);
    }
    const bytes = await this.files.fetchOrRender(
      {
        organizationId: context.organizationId,
        versionId: facts.deliverableVersionId,
        id: recordPdfObjectId([
          'signed',
          audience,
          facts.documentUnchanged ? 'unchanged' : 'changed',
          ...facts.signers.map((s) => s.recordHash),
        ]),
      },
      async () => {
        const marks = new Map<string, PdfImage>();
        for (const signer of facts.signers) {
          if (signer.markObjectKey === null || signer.markSha256 === null) continue;
          const image = await this.files.mark(signer.markObjectKey);
          if (image !== null) marks.set(signer.markSha256, image);
        }
        return renderRecordPdf(signedPdfDocument(facts, marks));
      },
    );
    return { bytes, fileName: `signed-${facts.requestId}.pdf` };
  }
}
