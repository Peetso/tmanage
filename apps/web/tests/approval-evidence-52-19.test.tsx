import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ApprovalCertificateView } from '../src/lib/api/approval-records';
import { approvalEvidenceZipPath } from '../src/lib/api/approval-records';
import { ApprovalRecordSheet } from '../src/components/screens/approvals/ApprovalCertificate';
import { PdfDownloadButton } from '../src/components/screens/approvals/PdfDownloadButton';

/** 52-19: "Download evidence" sits beside the record PDF while the record verifies. */
const H = 'a'.repeat(64);
const ids = { approvalId: 'ap1', organizationId: 'o', projectId: 'p1', deliverableId: 'd1' };
const view = (ok: boolean) =>
  ({
    ...{ ...ids, deliverableVersionId: 'v3', contentHash: H, state: 'approved', intact: ok },
    decidedAt: null,
    records: [
      {
        ...{ recordNo: 4, recordHash: H, previousRecordHash: H, signed: true },
        verification: { hashValid: ok, chainValid: true, signatureValid: ok },
        evidence: {
          ...{ ...ids, schema: 'tmanage.approval.record.v1', recordNo: 4, contentHash: H },
          ...{ deliverableVersionId: 'v3', previousRecordHash: H, versionNo: 3 },
          ...{ fileVersionId: null, decision: 'approved', comment: null, ip: null },
          ...{ decidedAt: '2026-11-12T11:32:00.000Z', userAgent: null },
          approver: { userId: 'u1', membershipId: 'm1', kind: 'internal', role: 'manager' },
        },
      },
    ],
  }) as unknown as ApprovalCertificateView;
const sheet = (ok: boolean) => (
  <ApprovalRecordSheet
    view={view(ok)}
    {...{ organizationName: 'North', deliverableTitle: 'Guide', projectName: null }}
    {...{ approverName: 'Layla', approverCompany: null, backHref: '/acme' }}
    pdfPath="/v1/x/record.pdf"
    evidencePath={approvalEvidenceZipPath('acme', 'ap1')}
  />
);

describe('52-19 approval evidence download', () => {
  it('offers the evidence ZIP only while the record verifies', () => {
    const { unmount } = render(sheet(true));
    expect(screen.getByRole('button', { name: 'Download evidence' })).toBeTruthy();
    unmount();
    render(sheet(false));
    expect(screen.queryByRole('button', { name: 'Download evidence' })).toBeNull();
  });

  it('fetches the evidence route and says so calmly when it fails', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 409 }));
    render(
      <PdfDownloadButton
        path={approvalEvidenceZipPath('acme', 'ap1')}
        {...{ fileName: 'e.zip', label: 'Download evidence', busyLabel: 'Preparing' }}
        failedLabel="The evidence could not be downloaded. Try again."
        help="One ZIP"
        fetchImpl={fetchImpl as unknown as typeof fetch}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Download evidence' }));
    expect(
      await screen.findByText('The evidence could not be downloaded. Try again.'),
    ).toBeTruthy();
    await waitFor(() =>
      expect(fetchImpl).toHaveBeenCalledWith(
        expect.stringMatching(/\/v1\/organizations\/acme\/approvals\/ap1\/evidence\.zip$/u),
        expect.objectContaining({ credentials: 'include' }),
      ),
    );
  });
});
