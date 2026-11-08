import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { NewGroupDialog } from '../src/components/chat/NewGroupDialog';
import { ApiClient } from '../src/lib/api/client';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => '/north/chat',
  useSearchParams: () => new URLSearchParams(),
}));

function harness() {
  const posts: { path: string; body: unknown }[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (init?.method === 'POST') {
      posts.push({ path: new URL(url).pathname, body: JSON.parse(String(init.body)) });
      return new Response('{"id":"g1"}', {
        status: 201,
        headers: { 'content-type': 'application/json' },
      });
    }
    const body = url.includes('/projects')
      ? '{"projects":[{"id":"pr1","name":"Atlas"}]}'
      : '{"members":[]}';
    return new Response(body, { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  const api = new ApiClient({
    baseUrl: 'https://api.example.test',
    csrfCookieName: 'tm_session_csrf',
    readCsrfToken: () => undefined,
    newCorrelationId: () => 'c1',
    fetch: fetchImpl,
  });
  const onCreated = vi.fn();
  render(
    <QueryClientProvider client={new QueryClient()}>
      <NewGroupDialog api={api} organizationSlug="north" onClose={vi.fn()} onCreated={onCreated} />
    </QueryClientProvider>,
  );
  return { posts, onCreated };
}

describe('NewGroupDialog — R38 G1 General option', () => {
  it('creates a General group linked to no project by default', async () => {
    const { posts, onCreated } = harness();
    expect(
      (
        screen.getByRole('radio', {
          name: /General \(not linked to a project\)/,
        }) as HTMLInputElement
      ).checked,
    ).toBe(true);
    fireEvent.change(screen.getAllByRole('textbox')[0] as HTMLElement, {
      target: { value: 'Tea room' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Create group' }));
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith('g1'));
    expect(posts[0]?.path).toBe('/v1/organizations/north/conversations');
    expect(posts[0]?.body).toEqual({ kind: 'group', name: 'Tea room' });
  });

  it('linked to a project, hides the people picker and waits for a project', async () => {
    harness();
    fireEvent.click(screen.getByRole('radio', { name: /A project/ }));
    expect(screen.queryByText('Add members')).toBeNull();
    fireEvent.change(screen.getAllByRole('textbox')[0] as HTMLElement, {
      target: { value: 'Atlas crew' },
    });
    const create = screen.getByRole('button', { name: 'Create group' }) as HTMLButtonElement;
    expect(create.disabled).toBe(true);
    await screen.findByRole('option', { name: 'Atlas' });
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'pr1' } });
    expect(create.disabled).toBe(false);
  });
});
