import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { DocsHubScreen } from '../src/components/screens/DocsHubScreen';
import { DocumentViewScreen } from '../src/components/screens/DocumentViewScreen';
import { ApiClient } from '../src/lib/api/client';
import { expectNoAxeViolations } from './axe';

/**
 * DOC-01 / DOC-03 read side (x106). The API's tenant scoping and the 404-not-403 refusal are
 * proved against a real MySQL in `apps/api/test/doc-001-documents.db.test.ts` and unit-tested in
 * `documents.test.ts`; nothing here re-proves them. What only this file can prove is what the
 * *screens* do with those answers:
 *
 * - the hub lists a chosen project's documents (sending `projectId` as a query parameter, so the
 *   scoping is the server's, not a client-side filter) and links each to its read screen;
 * - the read screen renders a document's title, body and metadata; and
 * - an id the API answers 404 for — unknown, cross-tenant or non-member, all the same 404 — is
 *   shown as a not-found state, with none of the document's content leaked.
 */

interface Call {
  readonly url: string;
}

function clientOver(handler: (call: Call) => Response): { client: ApiClient; calls: Call[] } {
  const calls: Call[] = [];
  const client = new ApiClient({
    baseUrl: 'https://api.example.test',
    csrfCookieName: 'tm_session_csrf',
    fetch: ((input: RequestInfo | URL) => {
      const call: Call = { url: String(input) };
      calls.push(call);
      return Promise.resolve(handler(call));
    }) as typeof globalThis.fetch,
    readCsrfToken: () => 'csrf-token',
    newCorrelationId: () => 'correlation-fixed',
  });
  return { client, calls };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function withQuery(children: ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

const PROJECT = 'project-1';
const NOW = '2026-09-01T12:00:00.000Z';

const project = {
  id: PROJECT,
  workspaceId: 'ws-1',
  name: 'Rebrand',
  status: 'active',
  ownerUserId: null,
  committedAt: null,
  forecastAt: null,
  createdAt: NOW,
  updatedAt: NOW,
  archivedAt: null,
};

function documentView(overrides: Record<string, unknown> = {}) {
  return {
    id: 'document-1',
    projectId: PROJECT,
    title: 'Kickoff brief',
    body: 'The plan for the quarter.\n\nSecond paragraph.',
    createdByUserId: 'user-1',
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function routeHubResponses(call: Call): Response {
  if (call.url.includes('/recent-documents')) {
    return json({
      documents: [
        {
          id: 'document-1',
          projectId: PROJECT,
          projectName: 'Rebrand',
          title: 'Kickoff brief',
          updatedAt: NOW,
          audience: 'client',
          clientAudienceCount: 2,
        },
      ],
      hiddenCount: 1,
    });
  }
  if (call.url.includes('/projects')) {
    return json({ projects: [project] });
  }
  if (call.url.includes('/workspaces')) {
    return json({ workspaces: [] });
  }
  return json({}, 200);
}

describe('DocsHubScreen', () => {
  it('opens on Recent with audience and the unreadable count, never a hidden title', async () => {
    const { client } = clientOver(routeHubResponses);
    render(
      withQuery(<DocsHubScreen organizationSlug="acme" organizationName="Acme" client={client} />),
    );

    expect(await screen.findByRole('link', { name: 'Kickoff brief' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Recent' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByText('Client · 2')).toBeTruthy();
    expect(screen.getByText('1 document in a space you cannot read')).toBeTruthy();
  });

  it('lists a chosen project’s documents, scoped by projectId, and links each to its read screen', async () => {
    const { client, calls } = clientOver(routeHubResponses);
    const { container } = render(
      withQuery(
        <DocsHubScreen
          organizationSlug="acme"
          organizationName="Acme"
          initialProjectId={PROJECT}
          client={client}
        />,
      ),
    );

    const link = await screen.findByRole('link', { name: 'Kickoff brief' });
    expect(link).toHaveAttribute('href', '/acme/docs/document-1');

    // The list read carried the project id to the API — the scoping is the server's.
    expect(calls.some((c) => c.url.includes(`/recent-documents?projectId=${PROJECT}`))).toBe(true);

    await expectNoAxeViolations(container);
  });
});

describe('DocumentViewScreen', () => {
  it('renders a document’s title, body, author byline and collaborator faces', async () => {
    const { client } = clientOver((call) =>
      call.url.endsWith('/sharing')
        ? json({
            audience: 'internal',
            publishedAt: null,
            clientAudienceCount: 2,
            collaborators: [
              { userId: 'user-1', displayName: 'Maya Hassan' },
              { userId: 'user-2', displayName: 'Omar Adel' },
            ],
            canPublish: false,
          })
        : json(documentView()),
    );
    const { container } = render(
      withQuery(
        <DocumentViewScreen
          organizationSlug="acme"
          organizationName="Acme"
          documentId="document-1"
          client={client}
        />,
      ),
    );

    expect(await screen.findByRole('heading', { level: 1, name: 'Kickoff brief' })).toBeTruthy();
    expect(screen.getByText('The plan for the quarter.')).toBeTruthy();
    expect(screen.getByText('Second paragraph.')).toBeTruthy();
    expect(
      await screen.findByRole('list', { name: /collaborators: maya hassan, omar adel/i }),
    ).toBeTruthy();
    expect(screen.getByText('Your team only — not shared yet')).toBeTruthy();
    // A caller the API says may not publish gets no Publish button.
    expect(screen.queryByRole('button', { name: 'Publish' })).toBeNull();

    await expectNoAxeViolations(container);
  });

  // Live test 2026-10-31: the read view showed raw "#", "**" and "- ", and links were plain text.
  it('draws the body Markdown as headings, lists, bold and safe links', async () => {
    const body = [
      '# The decision',
      'Some **bold words** here and a [work item](/acme/work/item-1).',
      '- list item one',
      '- [x] checked',
      '[bad](javascript:alert(1)) and https://example.com/page.',
    ].join('\n');
    const { client } = clientOver((call) =>
      call.url.endsWith('/sharing')
        ? json({
            audience: 'internal',
            publishedAt: null,
            clientAudienceCount: 2,
            collaborators: [],
            canPublish: false,
          })
        : json(documentView({ body })),
    );
    const { container } = render(
      withQuery(
        <DocumentViewScreen
          organizationSlug="acme"
          organizationName="Acme"
          documentId="document-1"
          client={client}
        />,
      ),
    );

    expect(await screen.findByRole('heading', { level: 2, name: 'The decision' })).toBeTruthy();
    expect(screen.getByText('bold words').tagName).toBe('STRONG');
    expect(screen.getByRole('link', { name: 'work item' })).toHaveAttribute(
      'href',
      '/acme/work/item-1',
    );
    expect(screen.getByRole('link', { name: 'https://example.com/page' })).toHaveAttribute(
      'rel',
      'noopener noreferrer',
    );
    expect(screen.queryByRole('link', { name: 'bad' })).toBeNull();
    expect(screen.getByText('list item one').tagName).toBe('LI');
    expect(screen.getByRole('img', { name: 'Done' })).toBeTruthy();
    expect(container.textContent).not.toContain('**');

    // The audience capsule opens the share dialog (Figma 446:35464).
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: /Your team only/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Share “Kickoff brief”' });
    expect(dialog).toHaveTextContent('Client people · 2 — can read after you publish');
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
    await expectNoAxeViolations(container);
  });

  it('shows a not-found state for a 404 id and leaks none of the document', async () => {
    const { client } = clientOver(() =>
      json(
        {
          error: {
            code: 'not_found',
            message: 'Not found.',
            correlationId: 'correlation-fixed',
          },
        },
        404,
      ),
    );
    const { container } = render(
      withQuery(
        <DocumentViewScreen
          organizationSlug="acme"
          organizationName="Acme"
          documentId="document-missing"
          client={client}
        />,
      ),
    );

    expect(await screen.findByText('Document not found')).toBeTruthy();
    // Nothing of a document surfaced — no secret title, no body.
    expect(screen.queryByText('Kickoff brief')).toBeNull();
    expect(screen.queryByText('The plan for the quarter.')).toBeNull();

    await expectNoAxeViolations(container);
  });
});
