import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { NewMenu } from '../src/components/shell/NewMenu';
import { ApiClient } from '../src/lib/api/client';

/** Row 55-05 — the shell's "+ New" menu: role-filtered create actions, keyboard menu button. */

function clientWithRole(role: string): ApiClient {
  return new ApiClient({
    baseUrl: 'https://api.example.test',
    csrfCookieName: 'tm_session_csrf',
    fetch: (() =>
      Promise.resolve(
        new Response(
          JSON.stringify({ organizations: [{ id: 'o1', slug: 'acme', name: 'Acme', role }] }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      )) as typeof globalThis.fetch,
    readCsrfToken: () => 'csrf-token',
    newCorrelationId: () => 'correlation-fixed',
  });
}

function withQuery(children: ReactNode) {
  const query = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={query}>{children}</QueryClientProvider>;
}

describe('NewMenu', () => {
  it('opens from the keyboard on the first item, moves, runs a link and closes', async () => {
    const navigate = vi.fn();
    render(
      withQuery(
        <NewMenu organizationSlug="acme" client={clientWithRole('owner')} navigate={navigate} />,
      ),
    );
    const button = await screen.findByRole('button', { name: 'New' });
    fireEvent.keyDown(button, { key: 'ArrowDown' });
    const items = screen.getAllByRole('menuitem');
    expect(items.map((item) => item.textContent)).toEqual([
      'New task',
      'New project',
      'New doc',
      'New meeting',
      'Log time',
      'Start timer',
    ]);
    await waitFor(() => expect(items[0]).toHaveFocus());
    fireEvent.keyDown(items[0]!, { key: 'ArrowDown' });
    await waitFor(() => expect(items[1]).toHaveFocus());
    fireEvent.click(items[1]!);
    expect(navigate).toHaveBeenCalledWith('/acme/projects/new');
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('offers a guest only what a guest may do, and Escape returns focus to the button', async () => {
    render(withQuery(<NewMenu organizationSlug="acme" client={clientWithRole('guest')} />));
    const button = await screen.findByRole('button', { name: 'New' });
    fireEvent.click(button);
    const labels = screen.getAllByRole('menuitem').map((item) => item.textContent);
    expect(labels).not.toContain('New project');
    expect(labels).not.toContain('New task');
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' });
    expect(button).toHaveFocus();
  });

  it('draws no button for a role that may do none of it', async () => {
    const { container } = render(
      withQuery(<NewMenu organizationSlug="acme" client={clientWithRole('client_viewer')} />),
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(container).toBeEmptyDOMElement();
  });
});
