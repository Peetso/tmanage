import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ApiClient } from '../src/lib/api/client';
import { NewChannelForm } from '../src/components/chat/NewChannelForm';

const push = vi.fn<(href: string) => void>();
vi.mock('next/navigation', () => ({ useRouter: () => ({ push }) }));

function mount() {
  const client = new ApiClient({
    baseUrl: 'https://api.example.test',
    csrfCookieName: 'tm_session_csrf',
    fetch: ((input: RequestInfo | URL, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      const url = String(input);
      const body =
        method === 'POST'
          ? {
              id: 'conv-new',
              kind: 'channel',
              projectId: 'p1',
              name: 'qa-chat',
              photoFileAssetId: null,
            }
          : url.endsWith('/projects')
            ? { projects: [{ id: 'p1', name: 'QA Project' }] }
            : {};
      return Promise.resolve(
        new Response(JSON.stringify(body), {
          status: method === 'POST' ? 201 : 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    }) as typeof globalThis.fetch,
    readCsrfToken: () => undefined,
    newCorrelationId: () => 'c',
  });
  const query = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={query}>
      <NewChannelForm api={client} organizationSlug="qa-org" />
    </QueryClientProvider>,
  );
}

describe('A3 — New channel opens the channel it created', () => {
  it('navigates to /<slug>/chat/<id> after a 201', async () => {
    push.mockClear();
    mount();
    const select = await screen.findByLabelText('Project');
    await screen.findByRole('option', { name: 'QA Project' });
    fireEvent.change(select, { target: { value: 'p1' } });
    fireEvent.change(screen.getByLabelText('Channel name'), { target: { value: 'qa-chat' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create channel' }));
    await waitFor(() => expect(push).toHaveBeenCalledWith('/qa-org/chat/conv-new'));
  });
});
