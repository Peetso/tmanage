import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it } from 'vitest';
import { ApiClient } from '../src/lib/api/client';
import { DownloadScanPolicyCard } from '../src/components/screens/DownloadScanPolicyCard';
import { NotScannedDownload } from '../src/components/screens/NotScannedDownload';
import { expectNoAxeViolations } from './axe';

/**
 * B5 — "Downloads before a virus scan" (Figma 388:3983): the owner card, the read-only state for
 * everyone else, and the Files row's "Not scanned" label and blocked-download message.
 */

interface Call {
  readonly method: string;
  readonly path: string;
  readonly body: unknown;
}

const POLICY_PATH = '/v1/organizations/northstar-studio/file-download-policy';

function fakeApi(scannerConfigured = false) {
  const calls: Call[] = [];
  let stored = 'allow_labeled';
  const client = new ApiClient({
    baseUrl: 'https://api.example.test',
    csrfCookieName: 'tm_session_csrf',
    fetch: ((input: string, init?: RequestInit) => {
      const url = new URL(input);
      const method = init?.method ?? 'GET';
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
      calls.push({ method, path: url.pathname, body });
      if (method === 'PATCH')
        stored = (body as { downloadsBeforeScan: string }).downloadsBeforeScan;
      return Promise.resolve(
        new Response(
          JSON.stringify({
            downloadsBeforeScan: stored,
            effective: scannerConfigured ? stored : 'allow_labeled',
            scannerConfigured,
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      );
    }) as typeof globalThis.fetch,
    readCsrfToken: () => undefined,
    newCorrelationId: () => 'correlation-fixed',
  });
  return { client, calls };
}

function withQuery(children: ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

describe('B5 Downloads before a virus scan — Control card', () => {
  it('the owner can choose Block until scanned and save it', async () => {
    const api = fakeApi();
    const { container } = render(
      withQuery(
        <DownloadScanPolicyCard organizationSlug="northstar-studio" client={api.client} isOwner />,
      ),
    );
    const allow = await screen.findByRole('radio', { name: /Allow, marked Not scanned/ });
    expect(allow).toBeChecked();
    expect(screen.getByText('Default')).toBeInTheDocument();
    expect(screen.getByText(/No virus scanner is connected yet/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();

    fireEvent.click(screen.getByRole('radio', { name: /Block until scanned/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() =>
      expect(api.calls).toContainEqual({
        method: 'PATCH',
        path: POLICY_PATH,
        body: { downloadsBeforeScan: 'block' },
      }),
    );
    expect(await screen.findByText('Setting saved')).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /Block until scanned/ })).toBeChecked();
    await expectNoAxeViolations(container);
  });

  it('Cancel puts the stored choice back without writing', async () => {
    const api = fakeApi(true);
    render(
      withQuery(
        <DownloadScanPolicyCard organizationSlug="northstar-studio" client={api.client} isOwner />,
      ),
    );
    const block = await screen.findByRole('radio', { name: /Block until scanned/ });
    expect(screen.queryByText(/No virus scanner is connected yet/)).toBeNull();
    fireEvent.click(block);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.getByRole('radio', { name: /Allow, marked Not scanned/ })).toBeChecked();
    expect(api.calls.filter((call) => call.method !== 'GET')).toEqual([]);
  });

  it('someone who is not the owner sees the choice read-only', async () => {
    const api = fakeApi();
    const { container } = render(
      withQuery(
        <DownloadScanPolicyCard
          organizationSlug="northstar-studio"
          client={api.client}
          isOwner={false}
        />,
      ),
    );
    const allow = await screen.findByRole('radio', { name: /Allow, marked Not scanned/ });
    expect(allow).toBeChecked();
    expect(allow).toBeDisabled();
    expect(screen.getByRole('radio', { name: /Block until scanned/ })).toBeDisabled();
    expect(screen.getByText('Only the company owner can change this setting.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
    expect(screen.queryByText(/No virus scanner is connected yet/)).toBeNull();
    await expectNoAxeViolations(container);
  });
});

describe('B5 Files — a file the scan has not checked yet', () => {
  const href = 'https://api.example.test/v1/organizations/northstar-studio/files/f1/content';

  it('shows the Not scanned label next to Download', () => {
    render(<NotScannedDownload href={href} fileName="Brand-guidelines-v3.pdf" />);
    expect(screen.getByText('Not scanned')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Download' })).toBeEnabled();
  });

  it('when the owner blocks it, Download is disabled and the row says why', async () => {
    const requested: string[] = [];
    const fetchImpl = ((input: string) => {
      requested.push(input);
      return Promise.resolve(
        new Response(
          JSON.stringify({
            code: 'conflict',
            message: 'Your company allows downloads only after the virus scan.',
            details: [{ field: 'status', message: 'scan_required_by_policy' }],
          }),
          { status: 409, headers: { 'content-type': 'application/json' } },
        ),
      );
    }) as typeof globalThis.fetch;
    render(
      <NotScannedDownload href={href} fileName="Homepage-hero-final.mp4" fetchImpl={fetchImpl} />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Download' }));
    expect(
      await screen.findByText(
        "This file can't be downloaded until it has been scanned for viruses. Your company owner chose this setting.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Download' })).toBeDisabled();
    expect(requested).toEqual([href]);
  });
});
