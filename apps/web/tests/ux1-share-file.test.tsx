import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ShareFileDialog } from '../src/components/viewer/ShareFileDialog';
import { ApiClient } from '../src/lib/api/client';

/**
 * UX-1 (live UX test 69836a13, O-P0-1): the viewer's Share was a grey button that never said why.
 * Now it says plainly when no client can open the project (with the way to fix it), and otherwise
 * shares the file with the client as a new deliverable — create, add the file, share — in one step.
 */

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function client(shares: readonly object[], calls: string[]): ApiClient {
  return new ApiClient({
    baseUrl: 'https://api.example.test',
    csrfCookieName: 'tm_session_csrf',
    fetch: ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      calls.push(`${method} ${url.replace('https://api.example.test/v1/organizations/acme', '')}`);
      if (url.endsWith('/projects/p1/clients')) return Promise.resolve(json({ clients: shares }));
      if (method === 'POST' && url.endsWith('/deliverables')) {
        return Promise.resolve(json({ id: 'd1', projectId: 'p1', title: 'Logo final' }, 201));
      }
      if (url.endsWith('/deliverables/d1/versions')) {
        return Promise.resolve(json({ id: 'v1', sharedWithClientAt: null }, 201));
      }
      if (url.endsWith('/versions/v1/share')) {
        return Promise.resolve(
          json({ deliverableVersionId: 'v1', sharedWithClientAt: '2026-11-15T10:00:00.000Z' }),
        );
      }
      return Promise.resolve(json({}, 404));
    }) as typeof globalThis.fetch,
    readCsrfToken: () => 'csrf-token',
    newCorrelationId: () => 'correlation-fixed',
  });
}

function renderDialog(api: ApiClient) {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <ShareFileDialog
        api={api}
        organizationSlug="acme"
        file={{ id: 'f1', name: 'Logo final.pdf', projectId: 'p1' }}
        fromDeliverable={false}
        onClose={() => undefined}
      />
    </QueryClientProvider>,
  );
}

describe('Share with client from the viewer (UX-1)', () => {
  it('explains why it cannot share when no client can open the project, and links to the fix', async () => {
    const calls: string[] = [];
    renderDialog(client([], calls));
    const invite = await screen.findByRole('link', { name: 'Invite someone from the client' });
    expect(invite.getAttribute('href')).toBe('/acme/clients');
    expect(screen.queryByRole('button', { name: 'Share with client' })).toBeNull();
    expect(calls.some((call) => call.startsWith('POST'))).toBe(false);
  });

  it('shares the file as a new deliverable and says what the client now sees', async () => {
    const calls: string[] = [];
    renderDialog(client([{ clientOrganizationId: 'c1', name: 'Atlas' }], calls));
    fireEvent.click(await screen.findByRole('button', { name: 'Share with client' }));
    expect(await screen.findByText('Shared')).toBeTruthy();
    expect(calls.filter((call) => call.startsWith('POST'))).toEqual([
      'POST /deliverables',
      'POST /deliverables/d1/versions',
      'POST /deliverables/d1/versions/v1/share',
    ]);
    expect(screen.getByRole('link', { name: 'Open the deliverable' }).getAttribute('href')).toBe(
      '/acme/projects/p1/deliverables/d1',
    );
    expect(screen.getByRole('link', { name: 'Preview as client' }).getAttribute('href')).toBe(
      '/acme/portal?project=p1',
    );
  });
});
