import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it } from 'vitest';
import { DocumentViewScreen } from '../src/components/screens/DocumentViewScreen';
import { DocumentExportButton } from '../src/components/screens/DocumentExportButton';
import { ApiClient } from '../src/lib/api/client';
import { expectNoAxeViolations } from './axe';

/**
 * DOC export (x131) web control. The API's tenant scoping, the 404-not-403 refusal and the
 * `doc.read` gate are proved server-side (`document-export.test.ts`, `capability.guard`); nothing
 * here re-proves them. What only this file can prove is what the *control* does: it renders an
 * accessible download link pointing at the export endpoint, and it does so without breaking the
 * document page's accessibility.
 */

interface Call {
  readonly url: string;
}

function clientOver(handler: (call: Call) => Response): ApiClient {
  const client = new ApiClient({
    baseUrl: 'https://api.example.test',
    csrfCookieName: 'tm_session_csrf',
    fetch: ((input: RequestInfo | URL) =>
      Promise.resolve(handler({ url: String(input) }))) as typeof globalThis.fetch,
    readCsrfToken: () => 'csrf-token',
    newCorrelationId: () => 'correlation-fixed',
  });
  return client;
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

const NOW = '2026-09-01T12:00:00.000Z';

function documentView() {
  return {
    id: 'document-1',
    projectId: 'project-1',
    title: 'Kickoff brief',
    body: 'The plan for the quarter.',
    createdByUserId: 'user-1',
    createdAt: NOW,
    updatedAt: NOW,
  };
}

describe('DocumentExportButton', () => {
  it('links to the export.md endpoint for the document', () => {
    render(
      <DocumentExportButton
        organizationSlug="acme"
        documentId="document-1"
        apiOrigin="https://api.example.test"
      />,
    );

    const link = screen.getByRole('link', { name: 'Export Markdown' });
    expect(link.getAttribute('href')).toBe(
      'https://api.example.test/v1/organizations/acme/documents/document-1/export.md',
    );
  });
});

describe('DocumentViewScreen export control', () => {
  it('shows the export link once the document loads and stays axe-clean', async () => {
    const { container } = render(
      withQuery(
        <DocumentViewScreen
          organizationSlug="acme"
          organizationName="Acme"
          documentId="document-1"
          client={clientOver(() => json(documentView()))}
        />,
      ),
    );

    // The control appears only with the loaded document (never linking to an unreadable id).
    const link = await screen.findByRole('link', { name: 'Export Markdown' });
    expect(link.getAttribute('href')).toContain('/documents/document-1/export.md');

    await expectNoAxeViolations(container);
  });

  it('does not show the export link on a 404 (nothing to export)', async () => {
    render(
      withQuery(
        <DocumentViewScreen
          organizationSlug="acme"
          organizationName="Acme"
          documentId="document-missing"
          client={clientOver(() =>
            json({ error: { code: 'not_found', message: 'Not found.', correlationId: 'c' } }, 404),
          )}
        />,
      ),
    );

    expect(await screen.findByText('Document not found')).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'Export Markdown' })).toBeNull();
  });
});
