import type { ApprovalCertificateView, ApprovalRecordView } from './api/approval-records';
import type { DeliverableVersionView } from './api/deliverables';

/**
 * 52-19 — what the approval-record screens say about a sealed record, as pure functions so the
 * panel, the portal card and the printable record can never disagree.
 */

/**
 * - `verified`: every record checks out and the approved fingerprint is the approval's fingerprint.
 * - `changed`: a record failed its check, or the approval now points at different content.
 * - `none`: nothing has been decided yet (no sealed record).
 */
export type RecordStatus = 'verified' | 'changed' | 'none';

export interface RecordSummary {
  readonly status: RecordStatus;
  /** The record the screens lead with: the newest approval, else the newest decision. */
  readonly decisive: ApprovalRecordView | null;
}

export function summarizeRecord(view: ApprovalCertificateView): RecordSummary {
  const ordered = [...view.records].sort((a, b) => b.recordNo - a.recordNo);
  const decisive =
    ordered.find((record) => record.evidence.decision === 'approved') ?? ordered[0] ?? null;
  if (!decisive) return { status: 'none', decisive: null };
  const recordFails = view.records.some(
    (record) =>
      !record.verification.hashValid ||
      !record.verification.chainValid ||
      record.verification.signatureValid === false,
  );
  const changed = !view.intact || recordFails || decisive.evidence.contentHash !== view.contentHash;
  return { status: changed ? 'changed' : 'verified', decisive };
}

function bareHash(hash: string): string {
  return hash.replace(/^sha256:/i, '').toLowerCase();
}

/** "9f2c41ab … 0b4ae07d" — enough to compare by eye. */
export function shortFingerprint(hash: string): string {
  const clean = bareHash(hash);
  return clean.length <= 20 ? clean : `${clean.slice(0, 8)} … ${clean.slice(-8)}`;
}

/** The whole fingerprint in groups of 16, as the printed record shows it. */
export function groupedFingerprint(hash: string): string {
  return (bareHash(hash).match(/.{1,16}/g) ?? []).join(' ');
}

/** The newest version whose approval was approved — the one a certificate exists for. */
export function approvedVersion(
  versions: readonly DeliverableVersionView[],
): (DeliverableVersionView & { readonly approval: { readonly id: string } }) | null {
  const approved = versions
    .filter((version) => version.approval?.state === 'approved')
    .sort((a, b) => (b.versionNo ?? 0) - (a.versionNo ?? 0))[0];
  return approved?.approval ? { ...approved, approval: approved.approval } : null;
}

/** The staff printable record of one approval. */
export function staffRecordHref(
  organizationSlug: string,
  projectId: string,
  deliverableId: string,
  approvalId: string,
): string {
  return `/${organizationSlug}/projects/${encodeURIComponent(projectId)}/deliverables/${encodeURIComponent(deliverableId)}/approvals/${encodeURIComponent(approvalId)}/record`;
}

/** The client's printable record of their own approval of one version. */
export function portalRecordHref(organizationSlug: string, deliverableVersionId: string): string {
  return `/${organizationSlug}/portal/deliverables/${encodeURIComponent(deliverableVersionId)}/record`;
}
