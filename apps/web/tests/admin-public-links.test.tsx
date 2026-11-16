import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ApiClient } from '../src/lib/api/client';
import type {
  ManagedPublicLinkView,
  PublicLinkManagerView,
} from '../src/lib/api/public-link-manager';
import { AdminPublicLinksScreen } from '../src/components/screens/AdminPublicLinksScreen';

/** 56-07p · Settings · Public links — the list, its row menu rules and the empty state. */
const NOW = new Date('2026-11-16T10:00:00.000Z');

function mount(body: PublicLinkManagerView) {
  const paths: string[] = [];
  const client = new ApiClient({
    baseUrl: 'https://api.example.test',
    csrfCookieName: 'tm_session_csrf',
    fetch: ((input: RequestInfo | URL) => {
      paths.push(String(input));
      return Promise.resolve(
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    }) as typeof globalThis.fetch,
    readCsrfToken: () => undefined,
    newCorrelationId: () => 'c',
  });
  const query = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={query}>
      <AdminPublicLinksScreen
        organizationSlug="northstar"
        organizationName="Northstar Studio"
        client={client}
        now={() => NOW}
      />
    </QueryClientProvider>,
  );
  return paths;
}

function link(overrides: Partial<ManagedPublicLinkView>): ManagedPublicLinkView {
  return {
    id: 'link-1',
    kind: 'approval',
    opens: { projectId: 'p-1', deliverableId: 'd-1' },
    title: 'Spring campaign logo',
    reference: '3',
    audienceEmail: 'dana@client.example',
    createdByUserId: 'u-1',
    createdByName: 'Ana Ruiz',
    createdAt: '2026-11-10T10:00:00.000Z',
    expiresAt: '2026-11-30T22:59:59.000Z',
    lastOpenedAt: null,
    openCount: 0,
    status: 'active',
    revokedAt: null,
    revokedByName: null,
    ...overrides,
  };
}

function view(links: readonly ManagedPublicLinkView[]): PublicLinkManagerView {
  return {
    links,
    total: links.length,
    page: 1,
    pageSize: 25,
    counts: { active: 1, endingSoon: 0, ended: links.length - 1 },
    kinds: ['approval', 'quote'],
    creators: [{ id: 'u-1', name: 'Ana Ruiz' }],
  };
}

describe('AdminPublicLinksScreen', () => {
  it('lists links from the manager route; an ended row cannot be selected or re-dated', async () => {
    const paths = mount(
      view([
        link({}),
        link({
          id: 'link-2',
          title: 'Q4 retainer quote',
          kind: 'quote',
          opens: { quoteId: 'q-1' },
          status: 'revoked',
          revokedAt: '2026-11-15T09:00:00.000Z',
          revokedByName: 'Ana Ruiz',
        }),
      ]),
    );
    expect(await screen.findByText('Spring campaign logo')).toBeTruthy();
    expect(screen.getByText('Q4 retainer quote')).toBeTruthy();
    expect(paths).toContainEqual(
      expect.stringContaining('/v1/organizations/northstar/public-links/manage?state=active'),
    );

    const live = screen.getByRole('checkbox', { name: /Spring campaign logo/ });
    const ended = screen.getByRole('checkbox', { name: /Q4 retainer quote/ });
    expect((live as HTMLInputElement).disabled).toBe(false);
    expect((ended as HTMLInputElement).disabled).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: /Actions for Q4 retainer quote/ }));
    const menu = await screen.findByRole('menu');
    expect(within(menu).getByText('Open what it shows')).toBeTruthy();
    expect(within(menu).queryByText('Change expiry')).toBeNull();
    expect(within(menu).queryByText('Revoke link')).toBeNull();
  });

  it('shows the empty state with a hint for each kind the workspace issues', async () => {
    mount({ ...view([]), counts: { active: 0, endingSoon: 0, ended: 0 } });
    expect(await screen.findByText('No public links yet')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Go to projects' })).toBeTruthy();
    expect(screen.queryByRole('table')).toBeNull();
  });
});
