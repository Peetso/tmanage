import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { CommandPalette } from '../src/components/screens/CommandPalette';
import { ApiClient } from '../src/lib/api/client';
import { expectNoAxeViolations } from './axe';

/**
 * SRCH command palette (x181). The API gate, matcher ranking and no-injection are proved in the
 * controller unit; this file proves only what the screen does with the response: an opened palette is
 * a focus-trapped, axe-clean dialog that renders the commands the API returns.
 */

function clientReturning(commands: unknown): ApiClient {
  return new ApiClient({
    baseUrl: 'https://api.example.test',
    csrfCookieName: 'tm_session_csrf',
    fetch: (() =>
      Promise.resolve(
        new Response(JSON.stringify({ commands }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      )) as typeof globalThis.fetch,
    readCsrfToken: () => 'csrf-token',
    newCorrelationId: () => 'correlation-fixed',
  });
}

function withQuery(children: ReactNode) {
  const query = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={query}>{children}</QueryClientProvider>;
}

describe('CommandPalette', () => {
  it('renders an opened palette as an axe-clean dialog listing the returned commands', async () => {
    const client = clientReturning([
      {
        id: 'nav-settings',
        title: 'Open settings',
        section: 'Navigate',
        kind: 'navigate',
        href: '/settings',
        action: null,
      },
    ]);
    const { container } = render(
      withQuery(<CommandPalette organizationSlug="acme" client={client} initiallyOpen />),
    );

    const dialog = await screen.findByRole('dialog', { name: 'Command palette' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    await waitFor(() => expect(screen.getByText('Open settings')).toBeInTheDocument());
    await expectNoAxeViolations(container);
  });

  it('groups rows, hides what the role may not create, and runs a row from the keyboard', async () => {
    const client = routedClient('guest', [
      {
        kind: 'project',
        id: 'p1',
        title: 'Website launch plan',
        projectId: 'p1',
        snippet: null,
        audience: 'internal',
        updatedAt: '2026-11-01T00:00:00Z',
      },
    ]);
    const navigate = vi.fn();
    render(
      withQuery(
        <CommandPalette
          organizationSlug="acme"
          client={client}
          navigate={navigate}
          searchDelayMs={0}
          initiallyOpen
        />,
      ),
    );
    const listbox = await screen.findByRole('listbox');
    await waitFor(() => expect(within(listbox).getByText('Switch workspace')).toBeInTheDocument());
    expect(within(listbox).queryByText('New project')).not.toBeInTheDocument();
    expect(within(listbox).getByRole('group', { name: 'Actions' })).toBeInTheDocument();

    const input = screen.getByRole('combobox');
    fireEvent.change(input, { target: { value: 'launch' } });
    const hit = await screen.findByRole('option', { name: /Website launch plan/ });
    expect(
      within(screen.getByRole('group', { name: 'In the workspace' })).getByText(
        'Website launch plan',
      ),
    ).toBeInTheDocument();
    // ACCOUNT item 5: the live hit matches the typed word, so it leads the "Search for …" row and
    // Enter opens it at once.
    await waitFor(() => expect(input).toHaveAttribute('aria-activedescendant', hit.id));
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(navigate).toHaveBeenCalledWith('/acme/projects/p1');
  });

  it('opens with Ctrl+K on an Arabic layout (physical key) and closes with Escape', () => {
    render(
      withQuery(<CommandPalette organizationSlug="acme" client={routedClient('owner', [])} />),
    );
    fireEvent.keyDown(document, { key: 'ن', code: 'KeyK', ctrlKey: true });
    const input = screen.getByRole('combobox');
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});

/** Answers each API path the palette reads: the role, the command registry and the search. */
function routedClient(role: string, results: unknown[]): ApiClient {
  return new ApiClient({
    baseUrl: 'https://api.example.test',
    csrfCookieName: 'tm_session_csrf',
    fetch: ((url: string) => {
      const path = String(url);
      const body = path.includes('/search/commands')
        ? { commands: [] }
        : path.includes('/search?')
          ? { results }
          : { organizations: [{ id: 'o1', slug: 'acme', name: 'Acme', role }] };
      return Promise.resolve(
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    }) as typeof globalThis.fetch,
    readCsrfToken: () => 'csrf-token',
    newCorrelationId: () => 'correlation-fixed',
  });
}
