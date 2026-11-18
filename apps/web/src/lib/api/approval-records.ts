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

/** 52-19 — the sealed certificate PDF (staff), relative to the API origin. */
export function approvalRecordPdfPath(organizationSlug: string, approvalId: string): string {
  return `${approvalsPath(organizationSlug)}/${encodeURIComponent(approvalId)}/record.pdf`;
}

/** 52-19 — the evidence bundle (record PDF, approved file, chain proof) as a ZIP (staff). */
export function approvalEvidenceZipPath(organizationSlug: string, approvalId: string): string {
  return `${approvalsPath(organizationSlug)}/${encodeURIComponent(approvalId)}/evidence.zip`;
}

/** 52-19 — the client's own certificate PDF for one published version. */
export function portalApprovalRecordPdfPath(
  organizationSlug: string,
  deliverableVersionId: string,
): string {
  return `${approvalsPath(organizationSlug)}/projections/${encodeURIComponent(deliverableVersionId)}/record.pdf`;
}

/**
 * Fetch a sealed record PDF with the session cookie (a `GET`, no CSRF token) and hand it to the
 * browser as a save. `false` when the server refused (403/404/409) or the network failed.
 */
export async function downloadRecordPdf(
  url: string,
  fileName: string,
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
): Promise<boolean> {
  let blob: Blob;
  try {
    const response = await fetchImpl(url, { method: 'GET', credentials: 'include' });
    if (!response.ok) return false;
    blob = await response.blob();
  } catch {
    return false;
  }
  if (typeof URL.createObjectURL !== 'function') return true;
  const objectUrl = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = objectUrl;
  anchor.download = fileName;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(objectUrl);
  return true;
}
