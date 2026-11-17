import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen } from '@testing-library/react';
import type { ReactElement } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { ClientsScreen } from '../src/components/screens/ClientsScreen';
import { DecisionRegisterScreen } from '../src/components/screens/DecisionRegisterScreen';
import { DocsHubScreen } from '../src/components/screens/DocsHubScreen';
import { FilesHubScreen } from '../src/components/screens/FilesHubScreen';
import { InboxScreen } from '../src/components/screens/InboxScreen';
import { ApiClient } from '../src/lib/api/client';
import { translate } from '../src/lib/i18n/t';

/** 55-10p: a truly empty list teaches with one action; a list with rows, or a filter, does not. */
type Routes = Record<string, unknown>;

function mount(screenFor: (client: ApiClient) => ReactElement, routes: Routes) {
  const answer = (path: string) =>
    Object.entries(routes)
      .filter(([suffix]) => path.endsWith(suffix))
      .sort(([a], [b]) => b.length - a.length)[0]?.[1];
  const client = new ApiClient({
    baseUrl: 'https://api.example.test',
    csrfCookieName: 'tm_session_csrf',
    fetch: ((input: RequestInfo | URL) => {
      const body = answer(new URL(String(input)).pathname);
      return Promise.resolve(
        new Response(JSON.stringify(body ?? {}), {
          status: body ? 200 : 404,
          headers: { 'content-type': 'application/json' },
        }),
      );
    }) as typeof globalThis.fetch,
    readCsrfToken: () => 'csrf',
    newCorrelationId: () => 'c',
  });
  const query = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  // The shell reads the role through its own browser client; seed it as an owner.
  query.setQueryData(['shell', 'organizations'], [{ slug: 'acme', role: 'owner' }]);
  render(<QueryClientProvider client={query}>{screenFor(client)}</QueryClientProvider>);
}

const teaching = (title: RegExp) => screen.findByRole('heading', { level: 2, name: title });

afterEach(() => {
  cleanup();
  window.history.replaceState(null, '', '/');
});

describe('teaching empty states (55-10p)', () => {
  it('Inbox: the empty All list teaches with Invite your team; an empty filter does not', async () => {
    const inbox = (client: ApiClient) => (
      <InboxScreen organizationSlug="acme" organizationName="Acme" client={client} />
    );
    mount(inbox, { '/inbox': { items: [], nextCursor: null } });
    await teaching(/your inbox is ready/i);
    expect(screen.getByRole('link', { name: /invite your team/i }).getAttribute('href')).toBe(
      '/acme/people',
    );
    cleanup();
    window.history.replaceState(null, '', '/?mode=waiting_on_me');
    mount(inbox, { '/inbox': { items: [], nextCursor: null } });
    await screen.findByText(translate('en-US', 'InboxScreen.emptyTitleWaiting'));
    expect(screen.queryByRole('heading', { name: /your inbox is ready/i })).toBeNull();
  });

  it('Docs: an empty Recent teaches with New doc; a doc on the list hides it', async () => {
    const docs = (client: ApiClient) => (
      <DocsHubScreen organizationSlug="acme" organizationName="Acme" client={client} />
    );
    mount(docs, { '/recent-documents': { documents: [], hiddenCount: 0 } });
    await teaching(/no documents yet/i);
    expect(screen.getAllByRole('button', { name: /new doc/i })).toHaveLength(2);
    cleanup();
    mount(docs, {
      '/recent-documents': {
        documents: [
          {
            id: 'd1',
            title: 'Brief',
            projectName: 'P',
            audience: 'internal',
            clientAudienceCount: 0,
            updatedAt: '2026-11-01T00:00:00Z',
          },
        ],
        hiddenCount: 0,
      },
    });
    await screen.findByRole('link', { name: 'Brief' });
    expect(screen.queryByRole('heading', { name: /no documents yet/i })).toBeNull();
  });

  it('Clients: no company teaches with Invite client; a company hides it', async () => {
    const clients = (client: ApiClient) => (
      <ClientsScreen organizationSlug="acme" organizationName="Acme" client={client} />
    );
    mount(clients, { '/client-organizations': { clientOrganizations: [] } });
    await teaching(/no clients yet/i);
    expect(screen.getAllByRole('button', { name: /invite client/i })).toHaveLength(2);
    cleanup();
    mount(clients, {
      '/client-organizations': {
        clientOrganizations: [
          { id: 'co', name: 'Atlas', createdAt: '', updatedAt: '', archivedAt: null },
        ],
      },
    });
    await screen.findByText('Atlas');
    expect(screen.queryByRole('heading', { name: /no clients yet/i })).toBeNull();
  });

  it('Decisions: an empty register teaches with Record a decision, which focuses the form', async () => {
    const decisions = (client: ApiClient) => (
      <DecisionRegisterScreen
        organizationSlug="acme"
        organizationName="Acme"
        initialProjectId="p1"
        client={client}
      />
    );
    const projects = { '/projects': { projects: [{ id: 'p1', name: 'North' }] } };
    mount(decisions, { ...projects, '/decisions': { decisions: [] } });
    await teaching(/no decisions yet/i);
    (await screen.findByRole('button', { name: /record a decision/i })).click();
    expect(document.activeElement?.getAttribute('name')).toBe('title');
    cleanup();
    mount(decisions, {
      ...projects,
      '/decisions': {
        decisions: [
          {
            id: 'd',
            projectId: 'p1',
            meetingId: null,
            title: 'Go',
            statement: 's',
            status: 'accepted',
            decidedBy: 'u',
            decidedAt: '2026-01-01T00:00:00Z',
            createdAt: '2026-01-01T00:00:00Z',
          },
        ],
      },
    });
    await screen.findByRole('rowheader', { name: /go/i });
    expect(screen.queryByRole('heading', { name: /no decisions yet/i })).toBeNull();
  });

  it('Files: an empty All projects teaches with Upload files; one chosen project does not', async () => {
    const routes = {
      '/projects': { projects: [{ id: 'p1', name: 'Site' }] },
      '/projects/p1/files': { files: [] },
    };
    mount(
      (client) => (
        <FilesHubScreen organizationSlug="acme" organizationName="Acme" client={client} />
      ),
      routes,
    );
    const section = (await teaching(/no files yet/i)).closest('section') as HTMLElement;
    expect(section.querySelector('button')?.textContent).toBe('Upload files');
    expect(section.querySelector('a')?.getAttribute('data-help-slug')).toBe(
      'upload-and-share-files',
    );
    cleanup();
    mount(
      (client) => (
        <FilesHubScreen
          organizationSlug="acme"
          organizationName="Acme"
          initialProjectId="p1"
          client={client}
        />
      ),
      routes,
    );
    await screen.findByText('No files yet');
    expect(screen.queryByRole('heading', { name: /no files yet/i })).toBeNull();
  });
});
