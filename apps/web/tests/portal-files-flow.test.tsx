import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it } from 'vitest';
import { PortalFilesScreen } from '../src/components/screens/PortalFilesScreen';
import { ApiClient } from '../src/lib/api/client';
import { expectNoAxeViolations } from './axe';

/**
 * FILE-003 · WEB-006 — the client Files screen.
 *
 * What the API enforces (client-org audience, the servable rule, 404 for a project the client
 * cannot read) is proved in `apps/api/.../portal-file-list.service.test.ts`. This file proves only
 * what the screen does with what it is given: it groups files by project and offers each one as a
 * download pointed at the **existing** authenticated door — never a new or widened route.
 */

function clientOver(handler: (url: string) => Response): ApiClient {
  return new ApiClient({
    baseUrl: 'https://api.example.test',
    csrfCookieName: 'tm_session_csrf',
    fetch: ((input: RequestInfo | URL) =>
      Promise.resolve(handler(String(input)))) as typeof globalThis.fetch,
    readCsrfToken: () => 'csrf-token',
    newCorrelationId: () => 'correlation-fixed',
  });
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function withQuery(children: ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

const PROJECT = {
  id: 'proj-1',
  name: 'Atlas Website Relaunch',
  status: 'active',
  committedAt: null,
  forecastAt: null,
};

function file(overrides: Record<string, unknown> = {}) {
  return {
    id: 'file-1',
    projectId: 'proj-1',
    name: 'brand-guide.pdf',
    sizeBytes: 2048,
    contentType: 'application/pdf',
    uploadedAt: '2026-09-19T00:00:00.000Z',
    scanStatus: 'clean',
    ...overrides,
  };
}

function portal(files: readonly unknown[], projects: readonly unknown[] = [PROJECT]): ApiClient {
  return clientOver((url) => {
    if (url.includes('/files')) return json({ files });
    return json({ projects });
  });
}

function renderFiles(files: readonly unknown[], projects: readonly unknown[] = [PROJECT]) {
  return render(
    withQuery(
      <PortalFilesScreen
        organizationSlug="northstar"
        clientName="Atlas Hospitality"
        providerName="Northstar Studio"
        client={portal(files, projects)}
      />,
    ),
  );
}

describe('PortalFilesScreen (FILE-003 · WEB-006)', () => {
  it('lists a file and links its download at the existing scoped download route', async () => {
    const { container } = renderFiles([file()]);

    const link = await screen.findByRole('link', { name: 'Download' });
    // The href is built on the existing `/portal/files/:fileAssetId/content` door, with the file's
    // own id — never a new route and never a widened grant.
    expect(link.getAttribute('href')).toContain(
      '/v1/organizations/northstar/portal/files/file-1/content',
    );
    expect(await screen.findByText('brand-guide.pdf')).toBeInTheDocument();

    await expectNoAxeViolations(container);
  });

  it('C4: a clean file carries no scan label', async () => {
    renderFiles([file()]);

    await screen.findByRole('link', { name: 'Download' });
    expect(screen.queryByText('Checked')).not.toBeInTheDocument();
    expect(screen.queryByText('Being checked for viruses')).not.toBeInTheDocument();
  });

  it('C4: an unscanned file the owner allows shows Checked and keeps Download', async () => {
    const { container } = renderFiles([file({ scanStatus: 'not_scanned' })]);

    expect(await screen.findByText('Checked')).toBeInTheDocument();
    const link = screen.getByRole('link', { name: 'Download' });
    expect(link.getAttribute('href')).toContain(
      '/v1/organizations/northstar/portal/files/file-1/content',
    );

    await expectNoAxeViolations(container);
  });

  it('C4: an unscanned file the owner blocks shows Being checked with Download disabled', async () => {
    const { container } = renderFiles([file({ scanStatus: 'being_checked' })]);

    expect(await screen.findByText('Being checked for viruses')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Download' })).not.toBeInTheDocument();
    const button = screen.getByRole('button', { name: 'Download' });
    expect(button).toBeDisabled();
    expect(button).toHaveAccessibleDescription(
      "This file can't be downloaded until it has been scanned for viruses. Your company owner chose this setting.",
    );

    await expectNoAxeViolations(container);
  });

  it('shows the empty state when the client has no files', async () => {
    renderFiles([]);

    expect(await screen.findByText('No files yet')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Download' })).not.toBeInTheDocument();
  });
});
