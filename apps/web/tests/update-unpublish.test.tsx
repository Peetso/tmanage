import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { UpdateLifecycleControls } from '../src/components/screens/UpdateLifecycleControls';
import { formatUpdateDay } from '../src/components/projects/UnpublishUpdateDialog';
import { ApiClient } from '../src/lib/api/client';
import type { ManagedUpdate } from '../src/lib/api/managed-updates';
import { translate, type MessageKey } from '../src/lib/i18n/t';

/**
 * A10 — the published update card and the unpublish confirm. What the API does with the POST is
 * the API's suite; this proves what the card shows, that Unpublish asks first (naming the client
 * who already opened the update), and what it sends. Labels are read through `translate`, so the
 * file holds whether or not the wave's i18n fragment has been merged yet.
 */
const L = (key: string, vars: Record<string, string> = {}) => {
  let text = translate('en-US', key as MessageKey);
  for (const [name, value] of Object.entries(vars)) text = text.split(`{${name}}`).join(value);
  return text;
};

const UPDATE: ManagedUpdate = {
  id: 'upd-1',
  projectId: 'proj-1',
  title: 'Week 3 update',
  body: 'Homepage and menu designs are ready for your review.',
  published: true,
  createdAt: '2026-10-21T09:00:00.000Z',
  updatedAt: '2026-10-21T09:00:00.000Z',
  authorName: 'Karim Adel',
  milestone: { id: 'ms-1', title: 'Design sign-off', dueOn: '2026-11-14' },
  clientOpened: { clientName: 'Atlas Hospitality', openedAt: '2026-10-22T10:00:00.000Z' },
};

interface Call {
  readonly url: string;
  readonly method: string;
}

function renderCard(update: ManagedUpdate = UPDATE) {
  const calls: Call[] = [];
  const client = new ApiClient({
    baseUrl: 'https://api.example.test',
    csrfCookieName: 'tm_session_csrf',
    readCsrfToken: () => 'csrf-token',
    newCorrelationId: () => 'correlation-fixed',
    fetch: ((input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), method: init?.method ?? 'GET' });
      return Promise.resolve(
        new Response(JSON.stringify({ ...update, published: false }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    }) as typeof fetch,
  });
  const queries = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={queries}>
      <UpdateLifecycleControls api={client} organizationSlug="acme" update={update} />
    </QueryClientProvider>,
  );
  return calls;
}

describe('A10 published update card + unpublish confirm', () => {
  it('formats days the way the design writes them', () => {
    expect(formatUpdateDay('2026-10-21T09:00:00.000Z', 'en-US')).toBe('Wed 21 Oct');
    expect(formatUpdateDay('2026-11-14', 'en-US', true)).toBe('Sat 14 Nov');
    expect(formatUpdateDay('2026-11-14', 'ar', true)).toMatch(/^\S+ 14 \S+$/);
  });

  it('shows author, the client-visible capsule and the linked milestone', () => {
    renderCard();
    expect(screen.getByRole('heading', { name: 'Week 3 update' })).toBeTruthy();
    expect(
      screen.getByText(L('UpdateCard.publishedBy', { date: 'Wed 21 Oct', name: 'Karim Adel' })),
    ).toBeTruthy();
    expect(screen.getByText(L('UpdateCard.clientCanSee'))).toBeTruthy();
    expect(
      screen.getByText(
        L('UpdateCard.linkedDue', { milestone: 'Design sign-off', date: 'Sat 14 Nov' }),
      ),
    ).toBeTruthy();
  });

  it('asks before unpublishing, naming the client who already opened it', async () => {
    const calls = renderCard();
    await userEvent.click(screen.getByRole('button', { name: L('UpdateCard.unpublish') }));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText(L('UnpublishUpdate.title', { title: 'Week 3 update' })));
    expect(
      within(dialog).getByText(
        L('UnpublishUpdate.opened', { client: 'Atlas Hospitality', date: 'Thu 22 Oct' }),
      ),
    ).toBeTruthy();
    expect(calls.filter((call) => call.method === 'POST')).toHaveLength(0);

    await userEvent.click(within(dialog).getByRole('button', { name: L('UnpublishUpdate.keep') }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(calls.filter((call) => call.method === 'POST')).toHaveLength(0);
  });

  it('unpublishes on confirm', async () => {
    const calls = renderCard();
    await userEvent.click(screen.getByRole('button', { name: L('UpdateCard.unpublish') }));
    const dialog = screen.getByRole('dialog');
    await userEvent.click(
      within(dialog).getByRole('button', { name: L('UnpublishUpdate.confirm') }),
    );
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    const post = calls.find((call) => call.method === 'POST');
    expect(post?.url).toContain('/projects/proj-1/updates/upd-1/unpublish');
  });

  it('offers no unpublish for a draft and no opened note when nobody opened it', async () => {
    renderCard({ ...UPDATE, published: false, clientOpened: null });
    expect(screen.queryByRole('button', { name: L('UpdateCard.unpublish') })).toBeNull();
    expect(screen.getByText(L('UpdateCard.draft'))).toBeTruthy();
  });
});
