import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { WorkCommentsPanel } from '../src/components/screens/WorkCommentsPanel';
import { ApiClient } from '../src/lib/api/client';

/** A19 (live test 2026-11-02): "@" in a work item comment must offer people and insert the pick. */

const MEMBERS = [
  { userId: 'u-ada', displayName: 'Ada Okonkwo', role: 'member', status: 'active' },
  { userId: 'u-omar', displayName: 'Omar Haddad', role: 'manager', status: 'active' },
];

function client(): ApiClient {
  return new ApiClient({
    baseUrl: 'https://api.example.test',
    csrfCookieName: 'tm_session_csrf',
    fetch: ((input: RequestInfo | URL) => {
      const url = String(input);
      const payload = url.includes('/members')
        ? { members: MEMBERS, nextAfter: null }
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
  });
});
