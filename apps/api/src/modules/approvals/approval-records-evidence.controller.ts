import { Controller, Get, Inject, Param, Res, StreamableFile } from '@nestjs/common';
import type { Principal } from '@tmanage/domain';
import type { TenantContext } from '../../common/database/tenant-context.js';
import { Ctx, CurrentPrincipal, RequireCapability } from '../../common/http/decorators.js';
import { Throttle } from '../rate-limits/throttle-policies.js';
import type { ApprovalEvidenceService } from './approval-records-evidence.service.js';
import type { HeaderWriter } from './record-pdf.controller.js';

/** Slice-private token, so `tokens.ts` stays untouched. */
export const APPROVAL_EVIDENCE_SERVICE = Symbol.for('tmanage.ApprovalEvidence');

const ZIP = 'application/zip';

/**
 * 52-19 · the approval's evidence bundle (record PDF + approved file + chain proof) as a ZIP,
 * beside `record.pdf` and behind the same capability; the service makes the per-record decision.
 * A copy of a client's file leaves the system, so it is rate-limited per organization like the
 * project export, and sent with the sibling downloads' headers.
 */
@Controller('v1/organizations/:orgSlug/approvals')
export class ApprovalEvidenceController {
  constructor(
    @Inject(APPROVAL_EVIDENCE_SERVICE) private readonly evidence: ApprovalEvidenceService,
  ) {}

  @Get(':approvalId/evidence.zip')
  @RequireCapability('approval.read')
  @Throttle('approval_evidence', {
    perMinute: 5,
    perHour: 30,
    key: 'link',
    linkParam: 'orgSlug',
    onStoreError: 'closed',
  })
  async download(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('approvalId') approvalId: string,
    @Res({ passthrough: true }) reply: HeaderWriter,
  ): Promise<StreamableFile> {
    const zip = await this.evidence.bundle(context, principal, approvalId);
    reply.header('content-type', ZIP);
    reply.header('content-length', String(zip.bytes.byteLength));
    reply.header('content-disposition', `attachment; filename="${zip.fileName}"`);
    reply.header('x-content-type-options', 'nosniff');
    reply.header('cache-control', 'private, no-store');
    return new StreamableFile(zip.bytes, { type: ZIP, length: zip.bytes.byteLength });
  }
}
