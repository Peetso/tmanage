import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { describe, expect, it } from 'vitest';
import { DocumentEditorScreen } from '../src/components/screens/DocumentEditorScreen';
import { ApiClient } from '../src/lib/api/client';

/**
 * **F2 — rename a doc in the editor (Figma 390:20145).**
 *
 * The API's optimistic rename, its audit row and its event are proved in `apps/api`. Here: a click
 * on the title opens the field with its hint, Esc puts the old name back, Enter sends the B4 PATCH
 * and the success toast offers Undo, and a 409 from somebody else's rename names them with
 * "Keep my name" / "Use “…”" while the bar says "Not saved".
 */

interface Call {
  readonly url: string;
  readonly method: string;
  readonly body: unknown;
}

const STAMP = '2026-10-25T09:00:00.000Z';
const LATER = '2026-10-25T09:01:00.000Z';
const DOC = {
  id: 'doc-1',
  projectId: 'proj-1',
  title: 'Untitled doc',
  body: '\n',
  createdByUserId: 'user-1',
  createdAt: STAMP,
  updatedAt: STAMP,
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function conflict(): Response {
  return json({ error: { code: 'conflict', message: 'Changed since', correlationId: 'c-1' } }, 409);
}

/** The server: `rename` decides the PATCH answer; `current` is what a GET reads. */
function server(rename: (call: Call) => Response, state: { current: typeof DOC }) {
  return (call: Call): Response => {
    if (call.url.includes('/recent-documents')) return json({ documents: [], hiddenCount: 0 });
    if (call.url.endsWith('/projects'))
      return json({ projects: [{ id: 'proj-1', name: 'Atlas relaunch' }] });
    if (call.url.includes('/members'))
      return json({
        members: [
          { userId: 'user-2', displayName: 'Salma Riad', role: 'member', status: 'active' },
        ],
        nextAfter: null,
      });
    if (call.url.includes('/sharing')) {
      return json({
        audience: 'internal',
        publishedAt: null,
        clientAudienceCount: 0,
        collaborators: [],
        canPublish: false,
      });
    }
    if (call.url.includes('/versions')) return json({ versions: [] });
    if (call.url.endsWith('/documents/doc-1')) {
      return call.method === 'PATCH' ? rename(call) : json(state.current);
    }
    return json({}, 404);
  };
}

function screenOver(handler: (call: Call) => Response, calls: Call[]) {
  const api = new ApiClient({
    baseUrl: 'https://api.example.test',
    csrfCookieName: 'tm_session_csrf',
    fetch: ((input: RequestInfo | URL, init?: RequestInit) => {
      const call = {
        url: String(input),
        method: (init?.method ?? 'GET').toUpperCase(),
        body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
      };
      calls.push(call);
      return Promise.resolve(handler(call));
    }) as typeof globalThis.fetch,
    readCsrfToken: () => 'csrf-token',
    newCorrelationId: () => 'correlation-fixed',
  });
  const query = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const wrap = (children: ReactNode) => (
    <QueryClientProvider client={query}>{children}</QueryClientProvider>
  );
  return render(
    wrap(
      <DocumentEditorScreen
        organizationSlug="acme"
        organizationName="Acme"
        documentId="doc-1"
        client={api}
      />,
    ),
  );
}

describe('DocumentEditorScreen — F2 rename in the editor', () => {
  it('opens the field with its hint, and Esc puts the old name back without a request', async () => {
    const calls: Call[] = [];
    const state = { current: DOC };
    screenOver(
      server(() => json(DOC), state),
      calls,
    );
    const user = userEvent.setup();
    const title = await screen.findByRole('button', { name: 'Untitled doc' });
    expect(title).toHaveAccessibleDescription('Click to rename');
    await user.click(title);

    const field = screen.getByRole('textbox', { name: 'Doc name' });
    expect(field).toHaveFocus();
    expect(screen.getByText('Press Enter to save or Esc to cancel')).toBeVisible();
    await user.clear(field);
    await user.type(field, 'Atlas launch plan{Escape}');

    expect(screen.getByRole('heading', { level: 2, name: 'Untitled doc' })).toBeVisible();
    expect(calls.some((call) => call.method === 'PATCH')).toBe(false);
  });

  it('Enter saves through the B4 PATCH and the toast offers Undo', async () => {
    const calls: Call[] = [];
    const state = { current: DOC };
    screenOver(
      server((call) => {
        const body = call.body as { title: string };
        state.current = { ...state.current, title: body.title, updatedAt: LATER };
        return json(state.current);
      }, state),
      calls,
    );
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Untitled doc' }));
    const field = screen.getByRole('textbox', { name: 'Doc name' });
    await user.clear(field);
    await user.type(field, 'Atlas launch plan{Enter}');

    expect(await screen.findByText('Doc renamed to “Atlas launch plan”')).toBeVisible();
    expect(screen.getByRole('heading', { level: 2, name: 'Atlas launch plan' })).toBeVisible();
    expect(screen.getByText('Saved · just now')).toBeVisible();
    const patch = calls.find((call) => call.method === 'PATCH');
    expect(patch?.body).toEqual({ title: 'Atlas launch plan', expectedUpdatedAt: STAMP });

    await user.click(screen.getByRole('button', { name: 'Undo' }));
    await waitFor(() =>
      expect(screen.getByRole('heading', { level: 2, name: 'Untitled doc' })).toBeVisible(),
    );
    const undo = calls.filter((call) => call.method === 'PATCH')[1];
    expect(undo?.body).toEqual({ title: 'Untitled doc', expectedUpdatedAt: LATER });
  });

  it('a rename by someone else names them; "Keep my name" renames on their version', async () => {
    const calls: Call[] = [];
    const theirs = {
      ...DOC,
      title: 'Atlas brief',
      updatedAt: LATER,
      titleUpdatedByUserId: 'user-2',
    };
    const state = { current: DOC };
    let patches = 0;
    screenOver(
      server((call) => {
        patches += 1;
        if (patches === 1) {
          state.current = theirs;
          return conflict();
        }
        const body = call.body as { title: string };
        state.current = { ...theirs, title: body.title, updatedAt: '2026-10-25T09:02:00.000Z' };
        return json(state.current);
      }, state),
      calls,
    );
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Untitled doc' }));
    const field = screen.getByRole('textbox', { name: 'Doc name' });
    await user.clear(field);
    await user.type(field, 'Atlas launch plan{Enter}');

    expect(
      await screen.findByText(
        'Salma Riad renamed this doc to “Atlas brief” a moment ago. Which name do you want to keep?',
      ),
    ).toBeVisible();
    expect(screen.getByText('Not saved')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Use “Atlas brief”' })).toBeVisible();
    expect(field).toHaveValue('Atlas launch plan');

    await user.click(screen.getByRole('button', { name: 'Keep my name' }));
    expect(await screen.findByText('Doc renamed to “Atlas launch plan”')).toBeVisible();
    const kept = calls.filter((call) => call.method === 'PATCH')[1];
    expect(kept?.body).toEqual({ title: 'Atlas launch plan', expectedUpdatedAt: LATER });
  });

  it('a 409 caused only by a body save is retried on the fresh version without asking', async () => {
    const calls: Call[] = [];
    const state = { current: DOC };
    let patches = 0;
    screenOver(
      server((call) => {
        patches += 1;
        if (patches === 1) {
          state.current = { ...DOC, body: 'Goals', updatedAt: LATER };
          return conflict();
        }
        const body = call.body as { title: string };
        state.current = { ...state.current, title: body.title };
        return json(state.current);
      }, state),
      calls,
    );
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Untitled doc' }));
    const field = screen.getByRole('textbox', { name: 'Doc name' });
    await user.clear(field);
    await user.type(field, 'Atlas launch plan{Enter}');

    expect(await screen.findByText('Doc renamed to “Atlas launch plan”')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Keep my name' })).toBeNull();
    const retried = calls.filter((call) => call.method === 'PATCH')[1];
    expect(retried?.body).toEqual({ title: 'Atlas launch plan', expectedUpdatedAt: LATER });
  });
});
