import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it } from 'vitest';
import { WorkItemTagsAndFiles } from '../src/components/screens/WorkItemTagsAndFiles';
import { ApiClient } from '../src/lib/api/client';

/**
 * C4 — the work item overview's file list labels a file the virus scan has not checked yet the
 * same way the work item Files row does (B5): Not scanned and a Download button, instead of a
 * dead name. A rejected file keeps its "could not be made available" line and no Download.
 */

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function apiWith(files: readonly unknown[]): ApiClient {
  return new ApiClient({
    baseUrl: 'https://api.example.test',
    csrfCookieName: 'tm_session_csrf',
    fetch: ((input: RequestInfo | URL) =>
      Promise.resolve(
        String(input).includes('/labels') ? json({ labels: [] }) : json({ files }),
      )) as typeof globalThis.fetch,
    readCsrfToken: () => 'csrf-token',
    newCorrelationId: () => 'correlation-fixed',
  });
}

function withQuery(children: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

function itemFile(availability: string, id: string) {
  return {
    id: `link-${id}`,
    workItemId: 'wi-1',
    fileAssetId: `asset-${id}`,
    fileName: `${id}.pdf`,
    availability,
    attachedByMembershipId: 'm-1',
    createdAt: '2026-10-25T00:00:00.000Z',
  };
}

describe('WorkItemTagsAndFiles — not scanned files (C4)', () => {
  it('shows Checked with Download for a file still being scanned', async () => {
    render(
      withQuery(
        <WorkItemTagsAndFiles
          organizationSlug="northstar"
          workItemId="wi-1"
          client={apiWith([itemFile('scanning', 'waiting')])}
          downloadBase="https://api.example.test"
        />,
      ),
    );

    expect(await screen.findByText('Checked')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Download' })).toBeEnabled();
  });

  it('offers no Download for a file that could not be made available', async () => {
    render(
      withQuery(
        <WorkItemTagsAndFiles
          organizationSlug="northstar"
          workItemId="wi-1"
          client={apiWith([itemFile('unavailable', 'rejected')])}
          downloadBase="https://api.example.test"
        />,
      ),
    );

    expect(await screen.findByText('rejected.pdf')).toBeInTheDocument();
    expect(screen.queryByText('Checked')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Download' })).not.toBeInTheDocument();
  });
});
