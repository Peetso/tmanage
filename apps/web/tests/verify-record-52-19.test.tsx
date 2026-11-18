import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ApiClient } from '../src/lib/api/client';
import {
  approvalRecordVerifyHref,
  readVerifyFragment,
  type ApprovalCertificateView,
  type PublicRecordVerdictView,
} from '../src/lib/api/approval-records';
import { ApiRequestError } from '../src/lib/api/errors';
import { VerifyRecordPage } from '../src/components/website/pages/verify/VerifyRecordPage';
import { ApprovalRecordSheet } from '../src/components/screens/approvals/ApprovalCertificate';

/**
 * 52-19 (web half): the public verify page posts the pasted ID and fingerprint (never in a URL),
 * shows the three verdicts in plain words with only the date and the workspace, fills itself from
 * the certificate link's fragment, and the certificate prints the ID, fingerprint and link.
 */
const ID = '0190a000-0000-7000-8000-00000000c0de';
const H = 'ab'.repeat(32);

function api(answer: PublicRecordVerdictView | Error) {
  const request = vi.fn(async () => {
    if (answer instanceof Error) throw answer;
    return { data: answer };
  });
  return { client: { request } as unknown as ApiClient, request };
}

function fill() {
  fireEvent.change(screen.getByLabelText('Record ID'), { target: { value: ID } });
  fireEvent.change(screen.getByLabelText('Fingerprint'), { target: { value: H } });
  fireEvent.click(screen.getByRole('button', { name: 'Check record' }));
}

afterEach(() => {
  window.history.replaceState(null, '', '/');
});

describe('52-19 public verify page', () => {
  it('posts the pair without a session and says genuine with the UTC date and workspace', async () => {
    const { client, request } = api({
      verdict: 'genuine',
      decidedAt: '2026-11-12T14:05:00.000Z',
      decision: 'approved',
      workspaceName: 'Nile Studio',
    });
    render(<VerifyRecordPage client={client} />);
    fill();
    expect(await screen.findByText('This record is genuine')).toBeTruthy();
    expect(request).toHaveBeenCalledWith({
      method: 'POST',
      path: '/v1/public/approval-records/verify',
      body: { recordId: ID, fingerprint: H },
      authentication: 'none',
    });
    const status = screen.getByRole('status');
    expect(status.textContent).toMatch(/Approved on .*2026.* at 14:05 UTC/);
    expect(status.textContent).toContain('Nile Studio');
  });

  it('says not found with nothing about any workspace', async () => {
    const { client } = api({
      verdict: 'not_found',
      decidedAt: null,
      decision: null,
      workspaceName: null,
    });
    render(<VerifyRecordPage client={client} />);
    fill();
    expect(await screen.findByText('We could not find this record')).toBeTruthy();
    const text = screen.getByRole('status').textContent ?? '';
    expect(text).not.toContain('Workspace');
    expect(text).toContain('ask the company that sent you the certificate.');
  });

  it('says altered in plain words, with the workspace but no date', async () => {
    const { client } = api({
      verdict: 'altered',
      decidedAt: null,
      decision: null,
      workspaceName: 'Nile Studio',
    });
    render(<VerifyRecordPage client={client} />);
    fill();
    expect(await screen.findByText('This record has been altered')).toBeTruthy();
    const text = screen.getByRole('status').textContent ?? '';
    // TManage serves every kind of company, not only agencies: the wording names none.
    expect(text).toContain('Ask the company that sent it for a new certificate.');
    expect(text).not.toContain('chain');
    expect(text).not.toContain('Approved on');
  });

  it('asks to wait a minute when the check is rate-limited', async () => {
    const { client } = api(new ApiRequestError(429, 'rate_limited', 'slow down', 'c1'));
    render(<VerifyRecordPage client={client} />);
    fill();
    expect(await screen.findByText('Too many checks. Try again in a minute.')).toBeTruthy();
  });

  it('checks at once from the certificate link fragment', async () => {
    window.history.replaceState(null, '', approvalRecordVerifyHref(ID, H));
    const { client, request } = api({
      verdict: 'genuine',
      decidedAt: '2026-11-12T14:05:00.000Z',
      decision: 'changes_requested',
      workspaceName: 'Nile Studio',
    });
    render(<VerifyRecordPage client={client} />);
    expect(await screen.findByText(/Changes asked for on/)).toBeTruthy();
    expect(request).toHaveBeenCalledTimes(1);
    expect((screen.getByLabelText('Record ID') as HTMLInputElement).value).toBe(ID);
  });

  it('keeps both values in the fragment of the link', () => {
    const href = approvalRecordVerifyHref(ID, H, true);
    expect(href.startsWith('/ar/verify#')).toBe(true);
    expect(href.split('#')[0]).not.toContain(H);
    expect(readVerifyFragment(href.slice(href.indexOf('#')))).toEqual({
      recordId: ID,
      fingerprint: H,
    });
  });
});

describe('52-19 certificate prints the check', () => {
  it('shows the record ID, its fingerprint and the verify link', async () => {
    const view = {
      approvalId: 'ap1',
      organizationId: 'o',
      projectId: 'p1',
      deliverableId: 'd1',
      deliverableVersionId: 'v3',
      contentHash: 'cd'.repeat(32),
      state: 'approved',
      decidedAt: null,
      intact: true,
      records: [
        {
          recordId: ID,
          recordNo: 4,
          recordHash: H,
          previousRecordHash: H,
          signed: true,
          verification: { hashValid: true, chainValid: true, signatureValid: true },
          evidence: {
            schema: 'tmanage.approval.record.v1',
            recordNo: 4,
            previousRecordHash: H,
            organizationId: 'o',
            projectId: 'p1',
            approvalId: 'ap1',
            deliverableId: 'd1',
            deliverableVersionId: 'v3',
            versionNo: 3,
            fileVersionId: null,
            contentHash: 'cd'.repeat(32),
            approver: {
              userId: 'u1',
              membershipId: 'm1',
              kind: 'client',
              role: 'client',
              clientOrganizationId: null,
            },
            decision: 'approved',
            comment: null,
            decidedAt: '2026-11-12T11:32:00.000Z',
            ip: null,
            userAgent: null,
          },
        },
      ],
    } satisfies ApprovalCertificateView;
    render(
      <ApprovalRecordSheet
        view={view}
        organizationName="Nile Studio"
        deliverableTitle="Brand guide"
        projectName={null}
        approverName={null}
        approverCompany={null}
        backHref="/back"
        pdfPath="/x.pdf"
      />,
    );
    await waitFor(() => expect(screen.getByText(ID)).toBeTruthy());
    const link = screen.getByRole('link', { name: /\/verify$/ });
    expect(link.getAttribute('href')).toBe(approvalRecordVerifyHref(ID, H));
    expect(screen.getByText('Record fingerprint')).toBeTruthy();
  });
});
