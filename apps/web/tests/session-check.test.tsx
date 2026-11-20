import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { EntrySessionGate } from '../src/components/session/EntrySessionGate';
import { ApiClient } from '../src/lib/api/client';
import { AuthBoundary } from '../src/lib/auth-boundary';
import { checkSession } from '../src/lib/session-check';

vi.mock('next/navigation', () => ({ useRouter: () => ({ replace: vi.fn() }) }));

/**
 * AUTHSTATE (live 2026-11-20, ENGINEERING-RULES §1.3): only a definite 401 means signed out. A
 * deploy restart (5xx, no answer) is "unknown" and must never show the sign-in form.
 */

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const ACCOUNT = { email: 'mona@northstar.studio', displayName: 'Mona Adel' };

/** A client whose answers come from `answer(path)`; records every path asked. */
function clientAnswering(answer: (path: string) => Promise<Response>) {
  const paths: string[] = [];
  const onSessionEnded = vi.fn();
  const client = new ApiClient({
    baseUrl: 'https://api.example.test',
    csrfCookieName: 'tm_session_csrf',
    fetch: ((input: RequestInfo | URL) => {
      const path = new URL(String(input)).pathname;
      paths.push(path);
      return answer(path);
    }) as typeof globalThis.fetch,
    readCsrfToken: () => 'v1.csrf',
    newCorrelationId: () => 'c',
    recovery: { onSessionEnded },
  });
  return { client, paths, onSessionEnded };
}

describe('checkSession', () => {
  it('answers "unknown", not "signed out", for a 503 or no answer', async () => {
    const restarting = clientAnswering(() =>
      Promise.resolve(json({ error: { code: 'unavailable', message: 'Restarting' } }, 503)),
    );
    const offline = clientAnswering(() => Promise.reject(new TypeError('fetch failed')));
    for (const { client, onSessionEnded } of [restarting, offline]) {
      await expect(checkSession(client, { mayHaveSession: true })).resolves.toEqual({
        state: 'unknown',
      });
      expect(onSessionEnded).not.toHaveBeenCalled();
    }
  });

  it('answers "signed out" only for a 401 whose refresh is refused', async () => {
    const { client, paths } = clientAnswering(() =>
      Promise.resolve(json({ error: { code: 'unauthenticated', message: 'Sign in' } }, 401)),
    );
    await expect(checkSession(client, { mayHaveSession: true })).resolves.toEqual({
      state: 'signed-out',
    });
    expect(paths).toEqual(['/v1/sessions/current', '/v1/sessions/refresh']);
  });
});

describe('EntrySessionGate', () => {
  it('shows a signed-in visitor "signed in as <name (email)>" with Continue, not the form', async () => {
    const { client } = clientAnswering((path) =>
      Promise.resolve(
        path === '/v1/sessions/current'
          ? json({ account: ACCOUNT })
          : json({ organizations: [{ id: 'o', slug: 'northstar', audience: 'internal' }] }),
      ),
    );
    render(
      <EntrySessionGate
        sessionHint
        client={client}
        boundary={new AuthBoundary()}
        mayHaveSession={() => true}
        search={() => ''}
      >
        <form aria-label="Sign in form" />
      </EntrySessionGate>,
    );
    await waitFor(() =>
      expect(screen.getByTestId('signed-in-card')).toHaveTextContent(
        "You're signed in as Mona Adel (mona@northstar.studio).",
      ),
    );
    expect(screen.queryByRole('form', { name: 'Sign in form' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Sign out' })).toBeEnabled();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Continue' })).toBeEnabled());
  });
});
