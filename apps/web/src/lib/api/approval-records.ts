import type { ApprovalState, ReviewerDecision } from '@tmanage/domain';
import type { ApiClient } from './client';

/**
 * 52-19 — the legal-grade approval record. Two reads of the same sealed data:
 *
 * - staff: `GET …/approvals/:approvalId/record` (`approval.read` on the project);
 * - portal: `GET …/approvals/projections/:deliverableVersionId/record` — the client's own records only.
 *
 * Every record is re-checked by the API on read; the screen only shows what it says (`intact`,
 * per-record `verification`). Records name people by id only — names come from the member and
 * client-contact directories.
 */

/** The sealed evidence exactly as stored — the API's `ApprovalEvidence`. */
export interface ApprovalRecordEvidence {
  readonly schema: 'tmanage.approval.record.v1';
  readonly recordNo: number;
  readonly previousRecordHash: string;
  readonly organizationId: string;
  readonly projectId: string;
  readonly approvalId: string;
  readonly deliverableId: string;
  readonly deliverableVersionId: string;
  readonly versionNo: number | null;
  readonly fileVersionId: string | null;
  /** SHA-256 (hex) of the exact version the approver decided on. */
  readonly contentHash: string;
  readonly approver: {
    readonly userId: string;
    readonly membershipId: string;
    readonly kind: 'internal' | 'client';
    readonly role: string;
    readonly clientOrganizationId: string | null;
  };
  readonly decision: ReviewerDecision;
  readonly comment: string | null;
  readonly decidedAt: string;
  readonly ip: string | null;
  readonly userAgent: string | null;
}

/** One sealed decision record and what checking it found — the API's `ApprovalRecordView`. */
export interface ApprovalRecordView {
  readonly recordNo: number;
  readonly recordHash: string;
  readonly previousRecordHash: string;
  readonly signed: boolean;
  readonly verification: {
    readonly hashValid: boolean;
    readonly chainValid: boolean;
    /** `null` = unsigned, or signed with a key this server no longer holds. */
    readonly signatureValid: boolean | null;
  };
  readonly evidence: ApprovalRecordEvidence;
}

/** The record data of one approval — the API's `ApprovalCertificateView`. */
export interface ApprovalCertificateView {
  readonly approvalId: string;
  readonly organizationId: string;
  readonly projectId: string;
  readonly deliverableId: string;
  readonly deliverableVersionId: string;
  readonly contentHash: string;
  readonly state: ApprovalState;
  readonly decidedAt: string | null;
  readonly intact: boolean;
  readonly records: readonly ApprovalRecordView[];
}

function approvalsPath(organizationSlug: string): string {
  return `/v1/organizations/${encodeURIComponent(organizationSlug)}/approvals`;
}

/** Staff read of one approval's sealed records. */
export async function getApprovalRecord(
  client: ApiClient,
  organizationSlug: string,
  approvalId: string,
): Promise<ApprovalCertificateView> {
  const { data } = await client.request<ApprovalCertificateView>({
    path: `${approvalsPath(organizationSlug)}/${encodeURIComponent(approvalId)}/record`,
  });
  return data;
}

/** Portal read: the signed-in client's own records for one published version. */
export async function getPortalApprovalRecord(
  client: ApiClient,
  organizationSlug: string,
  deliverableVersionId: string,
): Promise<ApprovalCertificateView> {
  const { data } = await client.request<ApprovalCertificateView>({
    path: `${approvalsPath(organizationSlug)}/projections/${encodeURIComponent(deliverableVersionId)}/record`,
  });
  return data;
}
