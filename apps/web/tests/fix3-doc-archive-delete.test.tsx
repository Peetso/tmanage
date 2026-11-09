import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { DocumentLifecycleActions } from '../src/components/docs/DocumentLifecycleActions';
import { ApiClient } from '../src/lib/api/client';
import type { DocumentView } from '../src/lib/api/documents';

/**
 * FIX3 item 6 (live check a6f66e47 D4): a doc can be archived, brought back and deleted. Delete
 * asks first and sends nothing until confirmed; a viewer who may not delete docs sees no Delete.
 */

const DOC: DocumentView = {
  id: 'doc-1',
  projectId: 'proj-1',
  title: 'Brief',
  body: '\n',
  bodyFormat: 'html',
  createdByUserId: 'user-1',
  createdAt: '2026-11-09T09:00:00.000Z',
  updatedAt: '2026-11-09T09:00:00.000Z',
};

function json(body: unknown, status = 200): Response {
  return new Response(status === 204 ? null : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function mount(role: string) {
  const calls: { url: string; method: string }[] = [];
  const api = new ApiClient({
    baseUrl: 'https://api.example.test',
    csrfCookieName: 'tm_session_csrf',
    fetch: ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? 'GET').toUpperCase();
      calls.push({ url, method });
      if (url.endsWith('/v1/organizations')) {
        return Promise.resolve(
          json({ organizations: [{ id: 'org-1', slug: 'acme', name: 'Acme', role }] }),
        );
      }
      if (url.endsWith('/archive')) {
        return Promise.resolve(json({ ...DOC, archivedAt: '2026-11-09T10:00:00.000Z' }));
      }
      if (method === 'DELETE') return Promise.resolve(json(null, 204));
      return Promise.resolve(json({}, 404));
    }) as typeof globalThis.fetch,
    readCsrfToken: () => 'csrf-token',
    newCorrelationId: () => 'correlation-fixed',
  });
  const query = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={query}>
      <DocumentLifecycleActions organizationSlug="acme" client={api} document={DOC} />
    </QueryClientProvider>,
  );
  return calls;
}

describe('doc archive and delete (FIX3 item 6)', () => {
  it('archives in one click and deletes only after the confirm dialog', async () => {
    const assign = vi.fn();
    vi.stubGlobal('location', { ...window.location, assign });
    const calls = mount('owner');
    const user = userEvent.setup();

    await user.click(await screen.findByRole('button', { name: 'Archive' }));
    await waitFor(() =>
      expect(calls.some((call) => call.url.endsWith('/documents/doc-1/archive'))).toBe(true),
    );

    await user.click(screen.getByRole('button', { name: 'Delete' }));
    expect(screen.getByRole('dialog', { name: 'Delete “Brief”?' })).toBeTruthy();
    expect(calls.some((call) => call.method === 'DELETE')).toBe(false);
    await user.click(screen.getByRole('button', { name: 'Delete doc' }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith('/acme/docs'));
    expect(calls.some((call) => call.method === 'DELETE' && call.url.endsWith('/doc-1'))).toBe(
      true,
    );
    vi.unstubAllGlobals();
  });

  it('shows no Delete to a role without doc.delete', async () => {
    mount('viewer');
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Delete' })).toBeNull());
  });
});
