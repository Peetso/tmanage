import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import type { ApiClient } from '../src/lib/api/client';
import type { ApprovalCertificateView } from '../src/lib/api/approval-records';
import { ApprovalRecordPanel } from '../src/components/screens/approvals/ApprovalRecordPanel';
import { PortalApprovalRecordCard } from '../src/components/screens/approvals/PortalApprovalRecordCard';

/** 52-19: the record panel shows what the API's re-check says; the portal links to the record. */
const H = 'a'.repeat(64);
const approver = { userId: 'u1', membershipId: 'm1', kind: 'internal', role: 'manager' } as const;
const evidence = { ...{ schema: 'tmanage.approval.record.v1', recordNo: 4 }, contentHash: H };
const ids = { approvalId: 'ap1', organizationId: 'o', projectId: 'p1', deliverableId: 'd1' };
const view = (ok: boolean) =>
  ({
    ...{ ...ids, deliverableVersionId: 'v3', contentHash: H, state: 'approved', intact: ok },
    decidedAt: null,
    records: [
      {
        ...{ recordId: 'r4', recordNo: 4, recordHash: H, previousRecordHash: H, signed: true },
        verification: { hashValid: ok, chainValid: true, signatureValid: ok },
        evidence: {
          ...{ ...evidence, ...ids, deliverableVersionId: 'v3', previousRecordHash: H },
          ...{ versionNo: 3, fileVersionId: null, decision: 'approved', comment: null },
          ...{ decidedAt: '2026-11-12T11:32:00.000Z', ip: null, userAgent: null },
          approver: { ...approver, clientOrganizationId: null },
        },
      },
    ],
  }) as ApprovalCertificateView;
const api = (v: ApprovalCertificateView) =>
  ({
    request: vi.fn(async ({ path }: { path: string }) => ({
      data: path.endsWith('/record')
        ? v
        : { members: [{ userId: 'u1', displayName: 'Layla Haddad' }], nextAfter: null },
    })),
  }) as unknown as ApiClient;
const wrap = (children: ReactNode) => (
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    {children}
  </QueryClientProvider>
);
const panel = (ok: boolean) =>
  wrap(
    <ApprovalRecordPanel
      {...{ api: api(view(ok)), organizationSlug: 'acme', projectId: 'p1', deliverableId: 'd1' }}
      approvalId="ap1"
    />,
  );
const certLink = () => screen.findByRole('link', { name: 'View certificate' });

describe('52-19 approval record', () => {
  it('a record that checks out reads Verified, names the approver and links to it', async () => {
    render(panel(true));
    expect(await screen.findByText('Layla Haddad')).toBeTruthy();
    expect(screen.getByText('The file matches what was approved.')).toBeTruthy();
    expect((await certLink()).getAttribute('href')).toBe(
      '/acme/projects/p1/deliverables/d1/approvals/ap1/record',
    );
  });

  it('a record that fails its check reads Changed and offers no certificate', async () => {
    render(panel(false));
    expect(await screen.findByText('Changed after approval')).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'View certificate' })).toBeNull();
  });

  it('the portal card links the client to their own printable record', async () => {
    const props = { organizationSlug: 'acme', deliverableVersionId: 'v3', providerName: 'A' };
    render(wrap(<PortalApprovalRecordCard api={api(view(true))} {...props} />));
    expect((await certLink()).getAttribute('href')).toBe('/acme/portal/deliverables/v3/record');
  });
});
