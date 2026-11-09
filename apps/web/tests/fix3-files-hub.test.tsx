import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { FilesHubScreen } from '../src/components/screens/FilesHubScreen';
import { ApiClient } from '../src/lib/api/client';

/**
 * FIX3 item 11 (live check a6f66e47 F2): `/files` was a 404. The Files hub (FIL-01) lists every
 * project's ready files, newest first, and each row opens the file in its viewer.
 */

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function file(id: string, projectId: string, name: string, updatedAt: string) {
  return {
    id,
    projectId,
    name,
    mimeType: 'text/csv',
    sizeBytes: 42,
    audience: 'internal',
    purpose: 'deliverable',
    versionNo: 1,
    updatedAt,
  };
}

describe('Files hub (FIX3 item 11)', () => {
  it('lists all projects’ files newest first, each linking to its viewer', async () => {
    const client = new ApiClient({
      baseUrl: 'https://api.example.test',
      csrfCookieName: 'tm_session_csrf',
      fetch: ((input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes('/projects/p1/files')) {
          return Promise.resolve(
            json({ files: [file('f1', 'p1', 'table.csv', '2026-11-09T09:00:00.000Z')] }),
          );
        }
        if (url.includes('/projects/p2/files')) {
          return Promise.resolve(
            json({ files: [file('f2', 'p2', 'brief.csv', '2026-11-09T10:00:00.000Z')] }),
          );
        }
        return Promise.resolve(
          json({
            projects: [
              { id: 'p1', name: 'Atlas' },
              { id: 'p2', name: 'Borealis' },
            ],
          }),
        );
      }) as typeof globalThis.fetch,
      readCsrfToken: () => 'csrf-token',
      newCorrelationId: () => 'correlation-fixed',
    });
    render(
      <QueryClientProvider client={new QueryClient()}>
        <FilesHubScreen organizationSlug="acme" organizationName="Acme" client={client} />
      </QueryClientProvider>,
    );
    const newest = await screen.findByRole('link', { name: 'brief.csv' });
    expect(newest.getAttribute('href')).toBe('/acme/files/f2');
    const links = screen.getAllByRole('link').filter((link) => link.textContent?.endsWith('.csv'));
    expect(links.map((link) => link.textContent)).toEqual(['brief.csv', 'table.csv']);
    expect(screen.getByRole('heading', { level: 1, name: 'Files' })).toBeTruthy();
  });
});
