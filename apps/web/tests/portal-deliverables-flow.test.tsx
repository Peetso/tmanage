import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it } from 'vitest';
import { ClientPortalDeliverablesScreen } from '../src/components/screens/ClientPortalDeliverablesScreen';
import { ApiClient } from '../src/lib/api/client';
import { expectNoAxeViolations } from './axe';

/**
 * **CL-03** against the reads x114 delivered.
 *
 * What the API enforces — the x97 allowlist, one client never seeing another's deliverable or
 * file, an unpublished deliverable staying invisible — is proved over fakes in
 * `apps/api/src/modules/clients/portal.service.test.ts` and against a real server in the DB
 * suite. This file proves only what the screen *shows*: the published projection and nothing
 * that looks like an internal field, files reached through a disclosure, and the empty states.
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
  committedAt: '2026-10-15',
  forecastAt: '2026-10-29',
};

function deliverable(overrides: Record<string, unknown> = {}) {
  return {
    id: 'dv-1',
    deliverableId: 'deliv-1',
    publishedAt: '2026-09-14T00:00:00.000Z',
    title: 'Homepage redesign',
    summary: 'The first cut of the new homepage.',
    milestoneState: 'in_review',
    forecastDate: '2026-10-01',
    publishedRisk: 'Copy is still being finalised.',
    decision: null,
    approvedContacts: ['Dana at the studio'],
    ...overrides,
  };
}

function file(overrides: Record<string, unknown> = {}) {
  return {
    id: 'file-1',
    name: 'homepage.pdf',
    sizeBytes: 2048,
    mimeType: 'application/pdf',
    updatedAt: '2026-09-15T00:00:00.000Z',
    ...overrides,
  };
}

function portal(options: {
  projects?: readonly unknown[];
  deliverables?: readonly unknown[];
  files?: readonly unknown[];
}): ApiClient {
  const projects = options.projects ?? [PROJECT];
  const deliverables = options.deliverables ?? [deliverable()];
  const files = options.files ?? [file()];
  return clientOver((url) => {
    if (url.includes('/files')) return json({ files });
    if (url.includes('/deliverables')) return json({ deliverables });
    return json({ projects });
  });
}

function renderScreen(client: ApiClient) {
  return render(
    withQuery(
      <ClientPortalDeliverablesScreen
        organizationSlug="northstar"
        clientName="Atlas Hospitality"
        providerName="Northstar Studio"
        client={client}
      />,
    ),
  );
}

describe('CL-03 the client deliverables', () => {
  it('shows the published projection of a deliverable', async () => {
    renderScreen(portal({}));

    await screen.findByText('Homepage redesign');
    expect(screen.getByText('The first cut of the new homepage.')).toBeInTheDocument();
    expect(screen.getByText('in_review')).toBeInTheDocument();
    expect(screen.getByText(/Copy is still being finalised/)).toBeInTheDocument();
    expect(screen.getByText(/Dana at the studio/)).toBeInTheDocument();
  });

  it('reaches files through a disclosure and lists their name and size', async () => {
    renderScreen(portal({}));

    const toggle = await screen.findByRole('button', { name: 'Show files' });
    // Closed by default — the file query has not run, so nothing is on screen.
    expect(screen.queryByText('homepage.pdf')).toBeNull();

    fireEvent.click(toggle);

    expect(await screen.findByText('homepage.pdf')).toBeInTheDocument();
    expect(screen.getByText(/2 KB · application\/pdf/)).toBeInTheDocument();
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
  });

  it('says nothing has been published when a project has no deliverables', async () => {
    renderScreen(portal({ deliverables: [] }));

    expect(
      await screen.findByText(/Northstar Studio has not published anything on Atlas Website/),
    ).toBeInTheDocument();
  });

  it('says nothing has been shared when the client is on no projects', async () => {
    renderScreen(portal({ projects: [] }));

    expect(await screen.findByText(/Nothing has been shared with you yet/)).toBeInTheDocument();
  });

  it('tells the client the download is not built rather than hiding the file', async () => {
    renderScreen(portal({}));

    await screen.findByText('Homepage redesign');
    expect(screen.getByText(/Downloading them from here is not built yet/)).toBeInTheDocument();
  });

  it('has no axe violations, with files open', async () => {
    const { container } = renderScreen(portal({}));

    fireEvent.click(await screen.findByRole('button', { name: 'Show files' }));
    await screen.findByText('homepage.pdf');
    await expectNoAxeViolations(container);
  });
});
