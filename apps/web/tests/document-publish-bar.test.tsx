import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { DocumentPublishBar } from '../src/components/docs/DocumentAudience';
import { ApiClient } from '../src/lib/api/client';

/** DOC-02 Publish: shown only when the API says the caller may publish; a click posts `publish`. */

function sharing(audience: 'internal' | 'client') {
  return {
    audience,
    publishedAt: null,
    clientAudienceCount: 2,
    collaborators: [{ userId: 'u-1', displayName: 'Maya Hassan' }],
    canPublish: true,
  };
}

describe('DocumentPublishBar', () => {
  it('publishes to the client audience and flips to Unpublish', async () => {
    const posts: string[] = [];
    const client = new ApiClient({
      baseUrl: 'https://api.example.test',
      csrfCookieName: 'tm_session_csrf',
      fetch: ((input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if ((init?.method ?? 'GET').toUpperCase() === 'POST') posts.push(url);
        const body = url.endsWith('/publish') ? sharing('client') : sharing('internal');
        return Promise.resolve(
          new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } }),
        );
      }) as typeof globalThis.fetch,
      readCsrfToken: () => 'csrf-token',
      newCorrelationId: () => 'correlation-fixed',
    });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <DocumentPublishBar organizationSlug="acme" documentId="doc-1" client={client} />
      </QueryClientProvider>,
    );

    await userEvent.setup().click(await screen.findByRole('button', { name: 'Publish' }));
    expect(await screen.findByRole('button', { name: 'Unpublish' })).toBeTruthy();
    expect(posts).toEqual([
      'https://api.example.test/v1/organizations/acme/documents/doc-1/publish',
    ]);
    expect(screen.getByText('Shared with clients · 2 people')).toBeTruthy();
  });
});
