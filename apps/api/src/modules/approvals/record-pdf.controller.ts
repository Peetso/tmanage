import { Controller, Get, Inject, Param, Res, StreamableFile } from '@nestjs/common';
import type { Principal } from '@tmanage/domain';
import type { TenantContext } from '../../common/database/tenant-context.js';
import { Ctx, CurrentPrincipal, RequireCapability } from '../../common/http/decorators.js';
import type {
  ApprovalCertificatePdfService,
  RecordPdfFile,
  SignedPdfService,
} from './record-pdf.service.js';

/** Slice-private tokens, so `tokens.ts` stays untouched. */
export const APPROVAL_CERTIFICATE_PDF_SERVICE = Symbol.for('tmanage.ApprovalCertificatePdf');
export const SIGNED_PDF_SERVICE = Symbol.for('tmanage.SignedPdf');

/** The one method a download needs of the framework reply: set a header before the first byte. */
interface HeaderWriter {
  header(name: string, value: string): unknown;
}

/**
 * The safe-download headers of the document export (x131): `attachment`, `nosniff`, and
 * `private, no-store` so no shared cache keeps a copy. The file name is built from ids only.
 */
function pdf(reply: HeaderWriter, file: RecordPdfFile): StreamableFile {
  reply.header('content-type', 'application/pdf');
  reply.header('content-disposition', `attachment; filename="${file.fileName}"`);
  reply.header('x-content-type-options', 'nosniff');
  reply.header('cache-control', 'private, no-store');
  return new StreamableFile(file.bytes, { type: 'application/pdf' });
}

/**
 * 52-19 · the approval certificate as a PDF, beside the JSON record routes. The capability is the
 * coarse ceiling; `ApprovalsService.certificate` / `clientCertificate` is the gate (project
 * relation; a client gets only their own records on a version published to them, else 404).
 */
@Controller('v1/organizations/:orgSlug/approvals')
export class ApprovalCertificatePdfController {
  constructor(
    @Inject(APPROVAL_CERTIFICATE_PDF_SERVICE)
    private readonly certificates: ApprovalCertificatePdfService,
  ) {}

  @Get(':approvalId/record.pdf')
  @RequireCapability('approval.read')
  async workspace(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('approvalId') approvalId: string,
    @Res({ passthrough: true }) reply: HeaderWriter,
  ): Promise<StreamableFile> {
    return pdf(reply, await this.certificates.workspace(context, principal, approvalId));
  }

  @Get('projections/:deliverableVersionId/record.pdf')
  @RequireCapability('approval.read')
  async portal(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('deliverableVersionId') deliverableVersionId: string,
    @Res({ passthrough: true }) reply: HeaderWriter,
  ): Promise<StreamableFile> {
    return pdf(reply, await this.certificates.portal(context, principal, deliverableVersionId));
  }
}

/** 52-26 · the team's copy of a signed document's signature pages. */
@Controller('v1/organizations/:orgSlug/signature-requests')
export class SignedPdfController {
  constructor(@Inject(SIGNED_PDF_SERVICE) private readonly signed: SignedPdfService) {}

  @Get(':signatureRequestId/signed.pdf')
  @RequireCapability('approval.read')
  async workspace(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('signatureRequestId') requestId: string,
    @Res({ passthrough: true }) reply: HeaderWriter,
  ): Promise<StreamableFile> {
    return pdf(reply, await this.signed.workspace(context, principal, requestId));
  }
}

/** 52-26 · the signer's own copy, in the portal; a request not addressed to them is a 404. */
@Controller('v1/organizations/:orgSlug/portal/signature-requests')
export class PortalSignedPdfController {
  constructor(@Inject(SIGNED_PDF_SERVICE) private readonly signed: SignedPdfService) {}

  @Get(':signatureRequestId/signed.pdf')
  @RequireCapability('client_projection.read')
  async portal(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('signatureRequestId') requestId: string,
    @Res({ passthrough: true }) reply: HeaderWriter,
  ): Promise<StreamableFile> {
    return pdf(reply, await this.signed.portal(context, principal, requestId));
  }
}
