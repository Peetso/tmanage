import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactElement } from 'react';
import { describe, expect, it } from 'vitest';
import { ApiClient } from '../src/lib/api/client';
import { PmImportScreen } from '../src/components/screens/PmImportScreen';
import { ProjectGithubScreen } from '../src/components/screens/ProjectGithubScreen';
import { WorkItemCodeLinks } from '../src/components/screens/WorkItemCodeLinks';
import { codeLinkLine, hooksForProject } from '../src/lib/api/github-repos';
import type { GithubRepoHook } from '../src/lib/api/github-repos';

/** R45 L3 — Trello / Asana token import (54-25) and the GitHub project settings (54-10). */

interface Call {
  method: string;
  url: string;
  body: string | null;
}

function client(route: (call: Call) => { status: number; body?: unknown }, calls: Call[]) {
  return new ApiClient({
    baseUrl: 'https://api.example.test',
    csrfCookieName: 'tm_session_csrf',
    fetch: ((input: RequestInfo | URL, init?: RequestInit) => {
      const call = {
        method: init?.method ?? 'GET',
        url: String(input),
        body: typeof init?.body === 'string' ? init.body : null,
      };
      calls.push(call);
      const { status, body } = route(call);
      return Promise.resolve(
        new Response(body === undefined ? null : JSON.stringify(body), {
          status,
          headers: { 'content-type': 'application/json' },
        }),
      );
    }) as typeof globalThis.fetch,
    readCsrfToken: () => undefined,
    newCorrelationId: () => 'c',
  });
}

function mount(ui: ReactElement) {
  const query = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={query}>{ui}</QueryClientProvider>);
}

const PROJECT = '0193f000-0000-7000-8000-000000000001';
const hook = (over: Partial<GithubRepoHook>): GithubRepoHook => ({
  id: 'h1',
  connectionId: 'c1',
  repoFullName: 'northstar/website',
  projectIds: [PROJECT],
  status: 'active',
  lastEventAt: null,
  createdAt: '2026-11-01T00:00:00.000Z',
  ...over,
});

describe('PmImportScreen (54-25)', () => {
  it('sends the token once to connect, clears it, maps lists and previews the counts', async () => {
    const calls: Call[] = [];
    const api = client(({ method, url }) => {
      if (url.endsWith('/trello/connect'))
        return {
          status: 200,
          body: { boards: [{ id: 'b'.repeat(24), name: 'Website relaunch', group: null }] },
        };
      if (url.endsWith('/trello/discover'))
        return {
          status: 200,
          body: {
            containers: ['Doing'],
            people: [],
            suggestion: { statusMap: { Doing: 'in_progress' }, userMap: {} },
            cardCount: 3,
            truncated: false,
          },
        };
      if (url.endsWith('/trello/preview'))
        return {
          status: 200,
          body: {
            counts: {
              cards: 3,
              comments: 4,
              dueDates: 2,
              assigned: 1,
              alreadyImported: 5,
              archivedSkipped: 0,
            },
            unmappedContainers: [],
            unmatchedPeople: [],
            truncated: false,
          },
        };
      if (url.endsWith('/projects'))
        return {
          status: 200,
          body: {
            projects: [
              {
                id: PROJECT,
                name: 'Website',
                workspaceId: 'w',
                status: 'active',
                ownerUserId: null,
              },
            ],
          },
        };
      if (url.includes('/members')) return { status: 200, body: { members: [], nextAfter: null } };
      return { status: method === 'GET' ? 200 : 404, body: {} };
    }, calls);
    mount(
      <PmImportScreen organizationSlug="northstar" organizationName="Northstar" client={api} />,
    );

    fireEvent.change(screen.getByLabelText(/API key/), { target: { value: 'f'.repeat(32) } });
    fireEvent.change(screen.getByLabelText(/^Token/), { target: { value: 't'.repeat(64) } });
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
    fireEvent.click(await screen.findByLabelText('Website relaunch'));
    const connect = calls.find((c) => c.url.endsWith('/connect'));
    expect(JSON.parse(connect?.body ?? '{}')).toEqual({
      apiKey: 'f'.repeat(32),
      token: 't'.repeat(64),
    });

    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    const project = await screen.findByLabelText('Import into project');
    await screen.findByRole('option', { name: 'Website' });
    fireEvent.change(project, { target: { value: PROJECT } });
    expect((screen.getByLabelText('Doing') as HTMLSelectElement).value).toBe('in_progress');
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
    expect(await screen.findByText('Already imported, skipped')).toBeTruthy();
    expect(screen.getByText('5')).toBeTruthy();
    const preview = calls.find((c) => c.url.endsWith('/preview'));
    expect(JSON.parse(preview?.body ?? '{}')).toMatchObject({
      projectId: PROJECT,
      boardIds: ['b'.repeat(24)],
      statusMap: { Doing: 'in_progress' },
    });
    expect(calls.filter((c) => c.body?.includes('t'.repeat(64)))).toHaveLength(1);
  });
});

describe('ProjectGithubScreen (54-10)', () => {
  it('lists only this project’s repositories and links one, showing the secret once', async () => {
    const calls: Call[] = [];
    const api = client(({ method }) => {
      if (method === 'POST')
        return {
          status: 201,
          body: {
            ...hook({ id: 'h3', repoFullName: 'northstar/api' }),
            secret: 's3cr3t',
            webhookUrl: 'https://tm.example/v1/public/integrations/github/h3',
          },
        };
      return {
        status: 200,
        body: {
          hooks: [hook({}), hook({ id: 'h2', repoFullName: 'other/repo', projectIds: ['x'] })],
        },
      };
    }, calls);
    mount(
      <ProjectGithubScreen
        organizationSlug="northstar"
        organizationName="Northstar"
        projectId={PROJECT}
        client={api}
      />,
    );
    expect(await screen.findByText('northstar/website')).toBeTruthy();
    expect(screen.queryByText('other/repo')).toBeNull();
    fireEvent.change(screen.getByLabelText(/Repository/), { target: { value: 'northstar/api' } });
    fireEvent.click(screen.getByRole('button', { name: 'Link repository' }));
    expect(await screen.findByText('s3cr3t')).toBeTruthy();
    expect(JSON.parse(calls.find((c) => c.method === 'POST')?.body ?? '{}')).toEqual({
      repoFullName: 'northstar/api',
      projectIds: [PROJECT],
    });
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    await waitFor(() => expect(screen.queryByText('s3cr3t')).toBeNull());
  });

  it('unlinks a repository', async () => {
    const calls: Call[] = [];
    const api = client(
      ({ method }) =>
        method === 'DELETE' ? { status: 204 } : { status: 200, body: { hooks: [hook({})] } },
      calls,
    );
    mount(
      <ProjectGithubScreen
        organizationSlug="northstar"
        organizationName="Northstar"
        projectId={PROJECT}
        client={api}
      />,
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Unlink northstar/website' }));
    await waitFor(() =>
      expect(calls.some((c) => c.method === 'DELETE' && c.url.endsWith('/repo-hooks/h1'))).toBe(
        true,
      ),
    );
  });
});

describe('WorkItemCodeLinks (54-10)', () => {
  it('shows a merged pull request and renders nothing without links', async () => {
    const link = {
      id: 'l1',
      provider: 'github',
      repo: 'northstar/website',
      kind: 'pr',
      externalId: '42',
      title: 'Add pricing page',
      state: 'merged',
      url: 'https://github.com/northstar/website/pull/42',
      actorLogin: null,
      updatedAt: '2026-11-01T00:00:00.000Z',
    };
    mount(
      <WorkItemCodeLinks
        organizationSlug="northstar"
        workItemId="w1"
        api={client(() => ({ status: 200, body: { workKey: 'WEB-12', links: [link] } }), [])}
      />,
    );
    expect(await screen.findByText('PR #42 · Add pricing page')).toBeTruthy();
    expect(screen.getByText('Merged')).toBeTruthy();
    expect(codeLinkLine({ ...link, kind: 'commit', externalId: '3f9c2a1bd', title: null })).toBe(
      '3f9c2a1',
    );
    expect(hooksForProject([hook({}), hook({ projectIds: [] })], PROJECT)).toHaveLength(1);
  });
});
