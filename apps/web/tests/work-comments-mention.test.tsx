import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { WorkCommentsPanel } from '../src/components/screens/WorkCommentsPanel';
import { ApiClient } from '../src/lib/api/client';

/**
 * A19 (live test 2026-11-02): "@" in a work item comment must offer people and insert the pick.
 * 53-11: the people come from the item's own mention-candidates route (only those who can see the
 * item), and the pick is sent as its `@<userId>` token so the person is notified.
 */

const MEMBERS = [
  { userId: 'u-ada', displayName: 'Ada Okonkwo', role: 'member', status: 'active' },
  { userId: 'u-omar', displayName: 'Omar Haddad', role: 'manager', status: 'active' },
];

const sent: { url: string; body: string }[] = [];

function client(): ApiClient {
  return new ApiClient({
    baseUrl: 'https://api.example.test',
    csrfCookieName: 'tm_session_csrf',
    fetch: ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === 'POST') sent.push({ url, body: String(init.body) });
      const q = (new URL(url).searchParams.get('q') ?? '').toLowerCase();
      const payload = url.includes('/mention-candidates')
        ? {
            candidates: MEMBERS.filter((m) => m.displayName.toLowerCase().includes(q)).map((m) => ({
              userId: m.userId,
              displayName: m.displayName,
              mention: `@${m.userId}`,
            })),
          }
        : url.includes('/members')
          ? { members: MEMBERS, nextAfter: null }
          : init?.method === 'POST'
            ? { id: 'c-1', workItemId: 'w-1', authorMembershipId: 'm', body: 'x', createdAt: '' }
            : { comments: [] };
      return Promise.resolve(
        new Response(JSON.stringify(payload), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    }) as typeof globalThis.fetch,
    readCsrfToken: () => 'csrf-token',
    newCorrelationId: () => 'correlation-fixed',
  });
}

describe('WorkCommentsPanel @mention', () => {
  it('lists matching people on "@", moves with the keyboard and inserts the pick', async () => {
    const queries = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queries}>
        <WorkCommentsPanel organizationSlug="acme" workItemId="w-1" api={client()} />
      </QueryClientProvider>,
    );

    const box = screen.getByRole('textbox');
    await userEvent.type(box, 'Ping @');
    expect(await screen.findByRole('option', { name: /Ada Okonkwo/ })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /Omar Haddad/ })).toBeInTheDocument();

    await userEvent.type(screen.getByRole('combobox'), 'o');
    await userEvent.keyboard('{ArrowDown}{Enter}');

    expect(screen.getByRole('textbox')).toHaveValue('Ping @Omar Haddad ');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();

    // 53-11: what is sent is the token, not the name — that is what notifies Omar.
    await userEvent.click(screen.getByRole('button', { name: /comment|add/i }));
    await waitFor(() => expect(sent.some((r) => r.url.includes('/w-1/comments'))).toBe(true));
    const post = sent.find((r) => r.url.includes('/w-1/comments'));
    expect(JSON.parse(post?.body ?? '{}')).toMatchObject({ body: 'Ping @u-omar' });
  });
});
