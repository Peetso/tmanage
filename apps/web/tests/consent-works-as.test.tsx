import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { describe, expect, it } from 'vitest';
import { ConsentScreen } from '../src/components/screens/ConsentScreen';
import { aiInitials } from '../src/components/screens/ConsentWorksAs';
import { ApiClient } from '../src/lib/api/client';
import type { WorksAsOptionView } from '../src/lib/api/oauth-consent';

/**
 * 60-07 S5 — the consent page's "This agent works as". The server rules (who may bind, status,
 * cap, `tmanage:agent` only) are proved in `apps/api/src/modules/oauth/works-as-consent.test.ts`
 * and `apps/api/src/modules/ai-employees/works-as.test.ts`; this file proves the screen: the
 * variant appears only with AI employees to choose, an unavailable row cannot be chosen and keeps
 * its reason, choosing an AI employee posts `worksAs` (no scopes), and "Me" keeps the switches.
 */

interface Call {
  readonly url: string;
  readonly method: string | undefined;
  readonly body: unknown;
}

const PARAMS = {
  client_id: 'https://claude.ai/oauth/mcp-oauth-client-metadata',
  redirect_uri: 'https://claude.ai/api/mcp/auth_callback',
  code_challenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
  code_challenge_method: 'S256',
  resource: 'https://tmanage.example/mcp',
  state: 's1',
};

const MAT = '0190b8a0-0000-7000-8000-00000000000a';
const RAMI = '0190b8a0-0000-7000-8000-00000000000c';

const OPTIONS: readonly WorksAsOptionView[] = [
  {
    id: MAT,
    displayName: 'Mat',
    jobTitle: 'Social media designer',
    available: true,
    unavailableReason: null,
  },
  {
    id: RAMI,
    displayName: 'Rami',
    jobTitle: 'Research assistant',
    available: false,
    unavailableReason: 'paused',
  },
];

function clientWith(options: readonly WorksAsOptionView[]): { client: ApiClient; calls: Call[] } {
  const calls: Call[] = [];
  const respond = (url: string): unknown => {
    if (url.includes('/v1/oauth/consent?')) {
      return {
        client: {
          name: 'Claude',
          verified: true,
          publisher: 'Anthropic',
          redirectHost: 'claude.ai',
          loopback: false,
        },
        requestedScopes: ['tmanage:read', 'tmanage:write'],
        platform: { offered: false, ready: false },
        ticket: '1000.ticket',
      };
    }
    if (url.endsWith('/v1/organizations')) {
      return {
        organizations: [
          {
            id: 'o1',
            slug: 'nile',
            name: 'Nile Studio',
            audience: 'internal',
            role: 'owner',
            clientOrganizationName: null,
          },
        ],
      };
    }
    if (url.endsWith('/oauth/consent/works-as')) return { aiEmployees: options };
    if (url.endsWith('/v1/sessions/current')) {
      return { account: { email: 'peter@example.test', displayName: 'Peter Kamal' } };
    }
    return { redirectUrl: 'https://claude.ai/api/mcp/auth_callback?code=c&state=s1' };
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

function approval(calls: readonly Call[]): Call | undefined {
  return calls.find(
    (call) => call.method === 'POST' && call.url.endsWith('/organizations/nile/oauth/consent'),
  );
}

describe('S5 consent: this agent works as', () => {
  it('lists Me and the AI employees, the first available one chosen, a paused one dimmed with its reason', async () => {
    const { client } = clientWith(OPTIONS);
    render(withQuery(<ConsentScreen params={PARAMS} client={client} navigate={() => {}} />));

    const group = await screen.findByRole('radiogroup', { name: /This agent works as/ });
    expect(group).toBeInTheDocument();
    expect(await screen.findByRole('radio', { name: /Me \(Peter Kamal\)/ })).not.toBeChecked();
    expect(screen.getByRole('radio', { name: /Mat/ })).toBeChecked();
    const rami = screen.getByRole('radio', { name: /Rami/ });
    expect(rami).toBeDisabled();
    expect(rami).toHaveAccessibleDescription('Paused');
    // The AI variant shows plain words, not the scope switches.
    expect(screen.getByText('Mat can')).toBeInTheDocument();
    expect(screen.getByText('Mat can never')).toBeInTheDocument();
    expect(screen.queryByRole('switch')).toBeNull();
    // The app and where the code goes stay on screen (threat model B2).
    expect(screen.getByText(/claude\.ai/)).toBeInTheDocument();
  });

  it('allows as the chosen AI employee: posts worksAs and no scopes, then follows the redirect', async () => {
    const { client, calls } = clientWith(OPTIONS);
    const went: string[] = [];
    render(
      withQuery(
        <ConsentScreen params={PARAMS} client={client} navigate={(url) => went.push(url)} />,
      ),
    );

    await screen.findByRole('radio', { name: /Mat/ });
    await userEvent.click(screen.getByRole('button', { name: /^Allow$/ }));

    await waitFor(() => expect(went).toHaveLength(1));
    const post = approval(calls);
    expect(post?.body).toMatchObject({ ...PARAMS, ticket: '1000.ticket', worksAs: MAT });
    expect(post?.body).not.toHaveProperty('scopes');
  });

  it('"Me" brings back the scope switches and approves with scopes, without worksAs', async () => {
    const { client, calls } = clientWith(OPTIONS);
    render(withQuery(<ConsentScreen params={PARAMS} client={client} navigate={() => {}} />));

    await userEvent.click(await screen.findByRole('radio', { name: /Me \(Peter Kamal\)/ }));
    expect(await screen.findAllByRole('switch')).toHaveLength(4);
    expect(screen.queryByText('Mat can')).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: /^Allow$/ }));

    await waitFor(() => expect(approval(calls)).toBeDefined());
    const body = approval(calls)?.body as Record<string, unknown>;
    expect(body).not.toHaveProperty('worksAs');
    expect(body['scopes']).toEqual(
      expect.arrayContaining(['tmanage:read', 'tmanage:write', 'tmanage:billing']),
    );
  });

  it('without AI employees to choose, the ordinary consent page is unchanged', async () => {
    const { client } = clientWith([]);
    render(withQuery(<ConsentScreen params={PARAMS} client={client} navigate={() => {}} />));

    expect(await screen.findAllByRole('switch')).toHaveLength(4);
    expect(screen.queryByRole('radiogroup')).toBeNull();
    expect(screen.getByRole('button', { name: /Consent\.allow$|Allow access/ })).toBeEnabled();
  });

  it('draws AI initials as designed', () => {
    expect(aiInitials('Mat')).toBe('MA');
    expect(aiInitials('Nour Adel')).toBe('NA');
    expect(aiInitials('زياد')).toBe('ز');
  });
});
