import { createHash } from 'node:crypto';
import type { Principal } from '@tmanage/domain';
import { ObjectNotFoundError } from '@tmanage/storage';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { AuditService } from '../audit/audit.service.js';
import { ProviderObjectUnavailableError } from '../files/provider-objects.js';
import type { VersionStore } from '../files/provider-objects.js';
import { zipStore } from '../finance/zip-store.js';
import {
  MAX_EVIDENCE_FILE_BYTES,
  evidenceEntries,
  evidenceZipName,
} from './approval-records-evidence.js';
import type { EvidenceFileFacts } from './approval-records-evidence.js';
import { ApprovalEvidenceRepository } from './approval-records-evidence.repository.js';
import type { EvidenceFile } from './approval-records-evidence.repository.js';
import type { ApprovalsService } from './approvals.service.js';
import type { ApprovalCertificatePdfService } from './record-pdf.service.js';

export interface EvidenceZip {
  readonly bytes: Buffer;
  /** ASCII-safe; built from the approval id only. */
  readonly fileName: string;
}

const SHA256_HEX = /^[0-9a-f]{64}$/u;

async function readCapped(stream: NodeJS.ReadableStream, max: number): Promise<Buffer | null> {
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

/**
 * 52-19 — `GET …/approvals/:approvalId/evidence.zip`: the record PDF, the approved file and the
 * chain proof in one download.
 *
 * Authorization is the record PDF's: {@link ApprovalsService.certificate} (staff `approval.read`
 * on the project; a client only their own records on a version published to them, else 404), and
 * a record that no longer verifies is refused with the PDF's 409 before anything is read. The
 * approved file goes in only when it was cleared into the private zone, is not infected, is within
 * {@link MAX_EVIDENCE_FILE_BYTES} and its bytes still hash to the stored SHA-256; otherwise the
 * proof names it by hash and says why. Every download writes `approval.evidence_exported`.
 */
export class ApprovalEvidenceService {
  constructor(
    private readonly database: TenantDatabase,
    private readonly approvals: Pick<ApprovalsService, 'certificate'>,
    private readonly pdfs: Pick<ApprovalCertificatePdfService, 'forView'>,
    private readonly versions: Pick<VersionStore, 'open'>,
    private readonly audit: Pick<AuditService, 'recordStandalone'>,
    private readonly repository: ApprovalEvidenceRepository = new ApprovalEvidenceRepository(),
    private readonly now: () => Date = () => new Date(),
  ) {}

  async bundle(
    context: TenantContext,
    principal: Principal,
    approvalId: string,
  ): Promise<EvidenceZip> {
    const view = await this.approvals.certificate(context, principal, approvalId);
    const audience = principal.kind === 'client' ? 'portal' : 'workspace';
    const pdf = await this.pdfs.forView(context, view, audience);
    const { stored, chainCheck } = await this.database.read(context, async (runner) => ({
      stored: await this.repository.approvedFile(runner, context, view.deliverableVersionId),
      chainCheck: await this.repository.latestChainCheck(runner, context),
    }));
    const file = stored === null ? null : await this.fileFacts(context, stored);
    const createdAt = this.now();
    const bytes = zipStore(
      evidenceEntries({ view, audience, recordPdf: pdf.bytes, chainCheck, file, createdAt }),
      createdAt,
    );
    await this.audit.recordStandalone(context, {
      action: 'approval.evidence_exported',
      result: 'allowed',
      objectId: view.approvalId,
      actorUserId: principal.userId,
      metadata: {
        record_count: view.records.length,
        file_outcome: file === null ? 'none' : file.outcome,
      },
    });
    return { bytes, fileName: evidenceZipName(view.approvalId) };
  }

  private async fileFacts(context: TenantContext, file: EvidenceFile): Promise<EvidenceFileFacts> {
    const sha256 = file.sha256 === null ? null : file.sha256.toLowerCase();
    const facts = {
      fileVersionId: file.fileVersionId,
      name: file.name,
      versionNo: file.versionNo,
      sizeBytes: file.sizeBytes,
      sha256,
    };
    const without = (outcome: EvidenceFileFacts['outcome']): EvidenceFileFacts => ({
      ...facts,
      outcome,
      bytes: null,
    });
    if (file.trustZone !== 'private' || file.scanVerdict === 'infected') {
      return without('not_cleared');
    }
    if (sha256 === null || !SHA256_HEX.test(sha256)) return without('unavailable');
    if (file.sizeBytes > MAX_EVIDENCE_FILE_BYTES) return without('too_large');

    let bytes: Buffer | null;
    try {
      const opened = await this.versions.open(context, file, 'private');
      bytes = await readCapped(opened.stream, MAX_EVIDENCE_FILE_BYTES);
    } catch (error) {
      if (error instanceof ObjectNotFoundError) return without('unavailable');
      if (error instanceof ProviderObjectUnavailableError) return without('unavailable');
      throw error;
    }
    if (bytes === null) return without('too_large');
    if (createHash('sha256').update(bytes).digest('hex') !== sha256) {
      return without('does_not_match');
    }
    return { ...facts, outcome: 'included', bytes };
  }
}
