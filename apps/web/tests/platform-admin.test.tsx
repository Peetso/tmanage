import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ApiClient } from '../src/lib/api/client';
import { PlatformOverviewScreen } from '../src/components/platform/PlatformAdminScreens';
import { AppShell } from '../src/components/shell/AppShell';

/** Platform admin (/platform): the API decides who gets in; suspended companies see one page. */

const query = () => new QueryClient({ defaultOptions: { queries: { retry: false } } });

describe('Platform admin', () => {
  it('shows not-found to anyone the API does not list', async () => {
    const client = new ApiClient({
      baseUrl: 'https://api.example.test',
      csrfCookieName: 'tm_session_csrf',
      fetch: (() =>
        Promise.resolve(
          new Response(JSON.stringify({ error: { code: 'not_found', message: 'x' } }), {
            status: 404,
            headers: { 'content-type': 'application/json' },
          }),
        )) as typeof globalThis.fetch,
      readCsrfToken: () => 'csrf',
      newCorrelationId: () => 'c',
    });
    render(
      <QueryClientProvider client={query()}>
        <PlatformOverviewScreen client={client} />
      </QueryClientProvider>,
    );
    expect(await screen.findByText('This page does not exist')).toBeTruthy();
  });

  it('shows a suspended company’s members the suspended page instead of the app', () => {
    const cache = query();
    cache.setQueryData(
      ['shell', 'organizations'],
      [
        {
          id: 'o',
          slug: 'northstar',
          name: 'N',
          audience: 'internal',
          role: 'owner',
          suspended: true,
        },
      ],
    );
    render(
      <QueryClientProvider client={cache}>
        <AppShell organizationSlug="northstar" organizationName="N" title="Work">
          <p>work content</p>
        </AppShell>
      </QueryClientProvider>,
    );
    expect(screen.getByText('This workspace is suspended')).toBeTruthy();
    expect(screen.queryByText('work content')).toBeNull();
  });
});
