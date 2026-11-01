import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { DocHistoryPanel } from '../src/components/docs/DocHistoryPanel';
import { ApiClient } from '../src/lib/api/client';

/** R5 frame 9: the versions newest first, and Restore posts the picked version number. */
describe('DocHistoryPanel', () => {
  it('lists versions newest first and restores the chosen one', async () => {
    const posts: string[] = [];
    const version = (n: number) => ({ id: `v${n}`, versionNo: n, body: '', editedByUserId: 'u' });
    const client = new ApiClient({
      baseUrl: 'https://api.example.test',
      csrfCookieName: 'tm_session_csrf',
      fetch: ((url: string, init?: RequestInit) => {
        if (init?.method === 'POST') posts.push(String(init.body));
        const body = { versions: [1, 3, 2].map(version), ...version(3), createdAt: '' };
        return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
      }) as typeof fetch,
      readCsrfToken: () => 'csrf',
      newCorrelationId: () => 'c',
    });
    let picked: number | null = null;
    const props = { organizationSlug: 'acme', documentId: 'd', client, onClose: () => {} };
    const queries = new QueryClient();
    const view = (n: number | null) => (
      <QueryClientProvider client={queries}>
        <DocHistoryPanel {...props} selectedVersionNo={n} onSelect={(v) => (picked = v)} />
      </QueryClientProvider>
    );
    const { rerender } = render(view(null));
    const rows = await screen.findAllByRole('button', { pressed: false });
    expect(rows.map((row) => row.textContent)).toEqual([
      expect.stringMatching(/version 2/i),
      expect.stringMatching(/version 1/i),
    ]);
    await userEvent.click(rows[1]!);
    rerender(view(picked));
    await userEvent.click(screen.getByRole('button', { name: /restore version 1/i }));
    await waitFor(() => expect(posts).toEqual([JSON.stringify({ versionNo: 1 })]));
  });
});
