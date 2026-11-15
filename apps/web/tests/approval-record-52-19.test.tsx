import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import type { ApiClient } from '../src/lib/api/client';
import type { ApprovalCertificateView } from '../src/lib/api/approval-records';
import { ApprovalRecordPanel } from '../src/components/screens/approvals/ApprovalRecordPanel';
import { PortalApprovalRecordCard } from '../src/components/screens/approvals/PortalApprovalRecordCard';

/** 52-19: the record panel shows what the API's re-check says; the portal links to the record. */
const HASH = 'a'.repeat(64);

function certificate(intact: boolean): ApprovalCertificateView {
  const evidence = {
    schema: 'tmanage.approval.record.v1',
    recordNo: 4,
    previousRecordHash: 'b'.repeat(64),
    organizationId: 'org',
    projectId: 'p1',
    approvalId: 'ap1',
    deliverableId: 'd1',
    deliverableVersionId: 'v3',
    versionNo: 3,
    fileVersionId: null,
    contentHash: HASH,
    approver: {
      userId: 'u1',
      membershipId: 'm1',
      kind: 'internal',
      role: 'manager',
      clientOrganizationId: null,
    },
    decision: 'approved',
    comment: null,
    decidedAt: '2026-11-12T11:32:00.000Z',
    ip: null,
    userAgent: null,
  } as const;
  return {
    approvalId: 'ap1',
    organizationId: 'org',
    projectId: 'p1',
    deliverableId: 'd1',
    deliverableVersionId: 'v3',
    contentHash: HASH,
    state: 'approved',
    decidedAt: evidence.decidedAt,
    intact,
    records: [
      {
        recordNo: 4,
        recordHash: 'c'.repeat(64),
        previousRecordHash: evidence.previousRecordHash,
        signed: true,
        verification: { hashValid: intact, chainValid: true, signatureValid: intact },
        evidence,
      },
    ],
  };
}

function apiFor(view: ApprovalCertificateView): ApiClient {
  const request = vi.fn(async ({ path }: { path: string }) => ({
    data: path.endsWith('/record')
      ? view
      : {
          members: [
            { userId: 'u1', displayName: 'Layla Haddad', role: 'manager', status: 'active' },
          ],
          nextAfter: null,
        },
  }));
  return { request } as unknown as ApiClient;
}

function wrap(children: ReactNode) {
  const queries = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={queries}>{children}</QueryClientProvider>;
}

const panel = (view: ApprovalCertificateView) =>
  wrap(
    <ApprovalRecordPanel
      api={apiFor(view)}
      organizationSlug="acme"
      projectId="p1"
      deliverableId="d1"
      approvalId="ap1"
    />,
  );

describe('52-19 approval record', () => {
  it('a record that checks out reads Verified, names the approver and links to the record', async () => {
    render(panel(certificate(true)));
    expect(await screen.findByText('Layla Haddad')).toBeTruthy();
    expect(screen.getByText('The file matches what was approved.')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'View certificate' }).getAttribute('href')).toBe(
      '/acme/projects/p1/deliverables/d1/approvals/ap1/record',
    );
  });

  it('a record that fails its check reads Changed and offers no certificate', async () => {
    render(panel(certificate(false)));
    expect(await screen.findByText('Changed after approval')).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'View certificate' })).toBeNull();
  });

  it('the portal card links the client to their own printable record', async () => {
    render(
      wrap(
        <PortalApprovalRecordCard
          api={apiFor(certificate(true))}
          organizationSlug="acme"
          deliverableVersionId="v3"
          providerName="Atlas Studio"
        />,
      ),
    );
    const link = await screen.findByRole('link', { name: 'View certificate' });
    expect(link.getAttribute('href')).toBe('/acme/portal/deliverables/v3/record');
  });
});
