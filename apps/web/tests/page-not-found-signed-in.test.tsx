import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { PageNotFoundState } from '../src/components/state/StateScreens';
import { ApiClient } from '../src/lib/api/client';
import type { OrganizationSummary } from '../src/lib/api/organizations';

/**
 * TESTUX P0 1: a signed-in owner who reached an unknown address saw "Back to home" (the public
 * site) and "Sign in" — both wrong for someone already in. The page-level 404 now leads back into
 * the workspace and drops the sign-in link; a signed-out visitor keeps both.
 */

function clientAnswering(response: () => Response): ApiClient {
  return new ApiClient({
    baseUrl: 'https://api.example.test',
    csrfCookieName: 'tm_session_csrf',
    fetch: (() => Promise.resolve(response())) as typeof globalThis.fetch,
    readCsrfToken: () => undefined,
    newCorrelationId: () => 'correlation-fixed',
    recovery: { onSessionEnded: vi.fn() },
  });
}

const CEDAR: OrganizationSummary = {
  id: 'org-cedar',
  slug: 'cedar-logistics',
  name: 'Cedar Logistics',
  audience: 'internal',
  role: 'owner',
  clientOrganizationName: null,
};

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('PageNotFoundState', () => {
  it('leads a signed-in owner back into the workspace, with no sign-in link', async () => {
    render(
      <PageNotFoundState client={clientAnswering(() => json({ organizations: [CEDAR] }, 200))} />,
    );
    const back = await screen.findByRole('link', { name: 'Back to your workspace' });
    expect(back).toHaveAttribute('href', '/cedar-logistics/home');
    expect(screen.queryByRole('link', { name: /sign in/i })).toBeNull();
  });

  it('keeps the sign-in link for a visitor who is not signed in', async () => {
    const client = clientAnswering(() =>
      json({ error: { code: 'unauthenticated', message: 'Sign in' } }, 401),
    );
    render(<PageNotFoundState client={client} />);
    expect(await screen.findByRole('link', { name: /sign in/i })).toHaveAttribute(
      'href',
      '/sign-in',
    );
    expect(screen.queryByRole('link', { name: 'Back to your workspace' })).toBeNull();
  });
});
