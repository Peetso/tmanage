import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { describe, expect, it } from 'vitest';
import { ConsentScreen } from '../src/components/screens/ConsentScreen';
import { ApiClient } from '../src/lib/api/client';

/**
 * S9 — the AI-app consent page (Figma S0-1). The server rules (ticket, billing role, cookie-only)
 * are proved in `apps/api/src/modules/oauth/consent.test.ts`; this file proves what the screen
 * does with them: an unverified app is gated behind the warning, and "Allow access" posts the
 * session-bound ticket and the chosen scopes to the chosen workspace, then follows the URL the
 * API returns. Labels match either the catalog key or its English text, so the test holds before
 * and after the `i18n-S9` fragments are merged into the catalogs.
 */

interface Call {
  readonly url: string;
  readonly method: string | undefined;
  readonly body: unknown;
}

const PARAMS = {
  client_id: 'abc',
  redirect_uri: 'https://notes.example/cb',
  code_challenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
  code_challenge_method: 'S256',
  resource: 'https://tmanage.example/mcp',
  state: 's1',
};

function clientOver(verified: boolean): { client: ApiClient; calls: Call[] } {
  const calls: Call[] = [];
  const respond = (url: string): unknown => {
    if (url.includes('/v1/oauth/consent?')) {
      return {
        client: {
          name: 'Field notes bot',
          verified,
          publisher: null,
          redirectHost: 'notes.example',
          loopback: false,
        },
        requestedScopes: ['tmanage:read', 'tmanage:write'],
        ticket: '1000.ticket',
      };
    }
    if (url.endsWith('/v1/organizations')) {
      return {
        organizations: [
          {
            id: 'o1',
            slug: 'northstar',
            name: 'Northstar Studio',
            audience: 'internal',
            role: 'member',
            clientOrganizationName: null,
          },
        ],
      };
    }
    return { redirectUrl: 'https://notes.example/cb?code=c&state=s1' };
  };
  const client = new ApiClient({
    baseUrl: 'https://api.example.test',
    csrfCookieName: 'tm_session_csrf',
    fetch: ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({
        url,
        method: init?.method,
        body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
      });
      return Promise.resolve(
        new Response(JSON.stringify(respond(url)), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    }) as typeof globalThis.fetch,
    readCsrfToken: () => 'csrf-token',
    newCorrelationId: () => 'correlation-fixed',
  });
  return { client, calls };
}

function withQuery(children: ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

describe('S9 consent screen', () => {
  it('gates an unverified app behind the warning before any choice is offered', async () => {
    const { client } = clientOver(false);
    render(withQuery(<ConsentScreen params={PARAMS} client={client} navigate={() => {}} />));

    await screen.findByText(/Consent\.checkBody|We could not confirm/);
    expect(screen.queryByRole('switch')).toBeNull();
    expect(screen.queryByRole('button', { name: /Consent\.allow$|Allow access/ })).toBeNull();

    await userEvent.click(
      screen.getByRole('button', { name: /Consent\.continueAnyway|Continue anyway/ }),
    );
    expect(await screen.findAllByRole('switch')).toHaveLength(4);
    // The redirect host is on screen for an unverified app (T-CON-01).
    expect(screen.getByText(/notes\.example/)).toBeInTheDocument();
  });

  it('allows with the ticket, the workspace and the chosen scopes, then follows the redirect', async () => {
    const { client, calls } = clientOver(true);
    const went: string[] = [];
    render(
      withQuery(
        <ConsentScreen params={PARAMS} client={client} navigate={(url) => went.push(url)} />,
      ),
    );

    const switches = await screen.findAllByRole('switch');
    // Owner 2026-11-23: every scope the person can grant is on by default; billing is greyed out
    // (and never sent) for a member.
    expect(switches[2]).toBeChecked();
    expect(switches[3]).toBeDisabled();
    expect(switches[3]).not.toBeChecked();
    await userEvent.click(screen.getByRole('button', { name: /Consent\.allow$|Allow access/ }));

    await waitFor(() => expect(went).toEqual(['https://notes.example/cb?code=c&state=s1']));
    const post = calls.find((call) => call.url.includes('/organizations/northstar/oauth/consent'));
    expect(post?.method).toBe('POST');
    expect(post?.body).toMatchObject({
      ...PARAMS,
      ticket: '1000.ticket',
      scopes: ['tmanage:read', 'tmanage:write', 'tmanage:manage'],
    });
  });

  it('keeps "change" and the chevron with one workspace, and change opens a one-item list', async () => {
    const { client } = clientOver(true);
    const { container } = render(
      withQuery(<ConsentScreen params={PARAMS} client={client} navigate={() => {}} />),
    );

    const row = await screen.findByRole('button', { name: /Northstar Studio/ });
    expect(row).toBeEnabled();
    expect(row).toHaveTextContent(/· (Consent\.change|change)/);
    expect(container.querySelector('.tm-consent__chevron')).not.toBeNull();
    expect(row).toHaveAttribute('aria-expanded', 'false');

    await userEvent.click(row);
    expect(row).toHaveAttribute('aria-expanded', 'true');
    const list = screen.getByRole('list', { name: /Consent\.chooseWorkspace|Choose a workspace/ });
    const items = list.querySelectorAll('li');
    expect(items).toHaveLength(1);
    expect(items[0]).toHaveTextContent('Northstar Studio');
  });
});
