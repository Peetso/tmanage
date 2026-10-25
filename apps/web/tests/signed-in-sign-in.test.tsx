import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SignInScreen } from '../src/components/screens/SignInScreen';
import { ApiClient } from '../src/lib/api/client';
import type { OrganizationSummary } from '../src/lib/api/organizations';
import { destinationForSignedIn, signedInDestination } from '../src/lib/signed-in-destination';

/**
 * Live check f30af1d0, lane E2: a signed-in person who opens `/sign-in` goes into the app —
 * their workspace home, or the picker when they have several — never to `/forbidden`, and
 * never to another host. A signed-out visitor sees the form exactly as before.
 */

function org(slug: string, audience: 'internal' | 'client' = 'internal'): OrganizationSummary {
  return {
    id: `id-${slug}`,
    slug,
    name: slug,
    audience,
    role: 'owner',
    clientOrganizationName: null,
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function clientAnswering(organizations: (() => Response) | Response) {
  const urls: string[] = [];
  const fetch = ((input: RequestInfo | URL) => {
    const url = String(input);
    urls.push(url);
    if (url.endsWith('/v1/auth/google')) {
      return Promise.resolve(json({ error: { code: 'not_found', message: 'Not found' } }, 404));
    }
    if (url.endsWith('/v1/organizations')) {
      return Promise.resolve(
        typeof organizations === 'function' ? organizations() : organizations.clone(),
      );
    }
    if (url.endsWith('/v1/auth/password')) {
      return Promise.resolve(
        json({ status: 'authenticated', csrfToken: 'v1.abc', expiresAt: '2026-11-01T00:00:00Z' }),
      );
    }
    return Promise.resolve(json({ error: { code: 'not_found', message: 'Not found' } }, 404));
  }) as typeof globalThis.fetch;
  const client = new ApiClient({
    baseUrl: 'https://api.example.test',
    csrfCookieName: 'tm_session_csrf',
    fetch,
    readCsrfToken: () => undefined,
    newCorrelationId: () => 'correlation-fixed',
    recovery: { onSessionEnded: vi.fn() },
  });
  return { client, urls, fetch };
}

const UNAUTHENTICATED = json({ error: { code: 'unauthenticated', message: 'Sign in' } }, 401);

afterEach(() => {
  window.history.replaceState(null, '', '/sign-in');
});

describe('destinationForSignedIn', () => {
  it('sends one internal workspace to its home and one client workspace to its portal', () => {
    expect(destinationForSignedIn([org('northstar')], null)).toBe('/northstar/home');
    expect(destinationForSignedIn([org('acme', 'client')], null)).toBe('/acme/portal');
  });

  it('sends several workspaces to the picker', () => {
    expect(destinationForSignedIn([org('a'), org('b')], null)).toBe('/organizations');
  });

  it('keeps the sign-in page when the person has no workspace', () => {
    expect(destinationForSignedIn([], null)).toBeUndefined();
  });

  it('honours an allowed ?next= and ignores a foreign or unknown one', () => {
    const invitation = `/invitations/${'a'.repeat(43)}`;
    expect(destinationForSignedIn([org('a')], invitation)).toBe(invitation);
    for (const next of [
      'https://evil.example',
      '//evil.example',
      '/\\evil.example',
      '/forbidden',
    ]) {
      expect(destinationForSignedIn([org('a')], next)).toBe('/a/home');
    }
  });

  it('never builds a path from a slug that could leave the site', () => {
    expect(destinationForSignedIn([org('/evil.example')], null)).toBe('/organizations');
    expect(destinationForSignedIn([org('\\evil.example')], null)).toBe('/organizations');
  });
});

describe('signedInDestination', () => {
  it('answers undefined when signed out, without the session-ended recovery', async () => {
    const onSessionEnded = vi.fn();
    const urls: string[] = [];
    const client = new ApiClient({
      baseUrl: 'https://api.example.test',
      csrfCookieName: 'tm_session_csrf',
      fetch: ((input: RequestInfo | URL) => {
        urls.push(String(input));
        return Promise.resolve(UNAUTHENTICATED.clone());
      }) as typeof globalThis.fetch,
      readCsrfToken: () => undefined,
      newCorrelationId: () => 'c',
      recovery: { onSessionEnded },
    });
    await expect(signedInDestination(client, null)).resolves.toBeUndefined();
    expect(onSessionEnded).not.toHaveBeenCalled();
    expect(urls.some((url) => url.endsWith('/v1/sessions/refresh'))).toBe(false);
  });

  it('answers undefined when the API cannot be reached', async () => {
    const client = new ApiClient({
      baseUrl: 'https://api.example.test',
      csrfCookieName: 'tm_session_csrf',
      fetch: (() => Promise.reject(new TypeError('offline'))) as typeof globalThis.fetch,
      readCsrfToken: () => undefined,
      newCorrelationId: () => 'c',
    });
    await expect(signedInDestination(client, null)).resolves.toBeUndefined();
  });
});

describe('opening /sign-in while signed in', () => {
  it('goes to the workspace home, not /forbidden', async () => {
    const { client } = clientAnswering(json({ organizations: [org('northstar')] }));
    const onAlreadySignedIn = vi.fn();
    render(
      <SignInScreen
        client={client}
        developmentSignInEnabled={false}
        onAlreadySignedIn={onAlreadySignedIn}
        mayHaveSession={() => true}
      />,
    );
    await waitFor(() => expect(onAlreadySignedIn).toHaveBeenCalledWith('/northstar/home'));
    expect(onAlreadySignedIn).not.toHaveBeenCalledWith('/forbidden');
  });

  it('goes to the picker when the person has several workspaces', async () => {
    const { client } = clientAnswering(json({ organizations: [org('a'), org('b')] }));
    const onAlreadySignedIn = vi.fn();
    render(
      <SignInScreen
        client={client}
        developmentSignInEnabled={false}
        onAlreadySignedIn={onAlreadySignedIn}
        mayHaveSession={() => true}
      />,
    );
    await waitFor(() => expect(onAlreadySignedIn).toHaveBeenCalledWith('/organizations'));
  });

  it('never follows a foreign ?next=', async () => {
    window.history.replaceState(null, '', '/sign-in?next=https%3A%2F%2Fevil.example%2F');
    const { client } = clientAnswering(json({ organizations: [org('northstar')] }));
    const onAlreadySignedIn = vi.fn();
    render(
      <SignInScreen
        client={client}
        developmentSignInEnabled={false}
        onAlreadySignedIn={onAlreadySignedIn}
        mayHaveSession={() => true}
      />,
    );
    await waitFor(() => expect(onAlreadySignedIn).toHaveBeenCalledWith('/northstar/home'));
  });
});

describe('opening /sign-in while signed out', () => {
  it('shows the form and does not navigate', async () => {
    const { client, urls } = clientAnswering(() => UNAUTHENTICATED.clone());
    const onAlreadySignedIn = vi.fn();
    render(
      <SignInScreen
        client={client}
        developmentSignInEnabled={false}
        onAlreadySignedIn={onAlreadySignedIn}
        mayHaveSession={() => true}
      />,
    );
    await waitFor(() => expect(urls.some((url) => url.endsWith('/v1/organizations'))).toBe(true));
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeEnabled();
    expect(onAlreadySignedIn).not.toHaveBeenCalled();
  });

  it('lets a sign-in that started first win over a late "already signed in" answer', async () => {
    let answer: (response: Response) => void = () => undefined;
    const held = new Promise<Response>((resolve) => {
      answer = resolve;
    });
    const { fetch: answering } = clientAnswering(json({ organizations: [org('northstar')] }));
    const slow = new ApiClient({
      baseUrl: 'https://api.example.test',
      csrfCookieName: 'tm_session_csrf',
      fetch: ((input: RequestInfo | URL, init?: RequestInit) =>
        String(input).endsWith('/v1/organizations')
          ? held
          : answering(input, init)) as typeof globalThis.fetch,
      readCsrfToken: () => undefined,
      newCorrelationId: () => 'c',
    });
    const onAlreadySignedIn = vi.fn();
    const onSignedIn = vi.fn();
    const user = userEvent.setup();
    render(
      <SignInScreen
        client={slow}
        developmentSignInEnabled={false}
        onAlreadySignedIn={onAlreadySignedIn}
        mayHaveSession={() => true}
        onSignedIn={onSignedIn}
      />,
    );
    await user.type(screen.getByLabelText(/Work email/), 'omar@northstar.studio');
    await user.type(screen.getByLabelText(/^Password/), 'a quiet line on paper');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    await waitFor(() => expect(onSignedIn).toHaveBeenCalledTimes(1));
    answer(json({ organizations: [org('northstar')] }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(onAlreadySignedIn).not.toHaveBeenCalled();
  });

  it('makes no check when the caller does not ask for one', async () => {
    const { client, urls } = clientAnswering(json({ organizations: [org('northstar')] }));
    render(
      <SignInScreen client={client} developmentSignInEnabled={false} mayHaveSession={() => true} />,
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(urls.some((url) => url.endsWith('/v1/organizations'))).toBe(false);
  });
});
