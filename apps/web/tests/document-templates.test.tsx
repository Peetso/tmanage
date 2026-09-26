import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { describe, expect, it } from 'vitest';
import { DocumentTemplatesScreen } from '../src/components/screens/DocumentTemplatesScreen';
import { ApiClient } from '../src/lib/api/client';
import { expectNoAxeViolations } from './axe';

/**
 * **DOC-04 template gallery + ADM-06 document templates (x119).**
 *
 * The API's authorize/relation logic and the Known-trap 404 are proved over fakes and a real server
 * in `apps/api`; nothing here re-proves them. What only this file can prove is what the *screen*
 * does: it lists templates with their purpose, carries a create form, applies a template to a
 * project and links to the new document, and has an accessible structure (a labelled gallery region,
 * a table caption and column headers) with no axe violation jsdom can detect.
 */

interface Call {
  readonly url: string;
  readonly method: string;
}

function clientOver(handler: (call: Call) => Response): ApiClient {
  return new ApiClient({
    baseUrl: 'https://api.example.test',
    csrfCookieName: 'tm_session_csrf',
    fetch: ((input: RequestInfo | URL, init?: RequestInit) =>
      Promise.resolve(
        handler({ url: String(input), method: (init?.method ?? 'GET').toUpperCase() }),
      )) as typeof globalThis.fetch,
    readCsrfToken: () => 'csrf-token',
    newCorrelationId: () => 'correlation-fixed',
  });
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

const AUTHOR = 'user-0000-0000-0000-0000-0000000000aa';

function template(id: string, name: string, purpose: string) {
  return {
    id,
    name,
    purpose,
    body: `${name} body`,
    createdByUserId: AUTHOR,
    createdAt: '2026-09-26T10:00:00.000Z',
  };
}

const PROJECT = {
  id: 'proj-1',
  workspaceId: 'ws-1',
  name: 'Acme site',
  status: 'active',
  ownerUserId: null,
  committedAt: null,
  forecastAt: null,
  createdAt: '2026-09-01T10:00:00.000Z',
  updatedAt: '2026-09-01T10:00:00.000Z',
  archivedAt: null,
};

function screenOver(templates: readonly ReturnType<typeof template>[], projects = [PROJECT]) {
  const client = clientOver((call) => {
    if (call.url.includes('/apply')) {
      return json({
        id: 'doc-new',
        projectId: PROJECT.id,
        title: templates[0]?.name ?? 'New',
        body: 'seeded',
        createdByUserId: AUTHOR,
        createdAt: '2026-09-26T11:00:00.000Z',
        updatedAt: '2026-09-26T11:00:00.000Z',
      });
    }
    if (call.url.includes('/documents/templates')) {
      if (call.method === 'POST') return json(template('doc-tpl-new', 'Fresh', 'A fresh template'));
      return json({ templates });
    }
    if (call.url.includes('/projects')) return json({ projects });
    return json({}, 404);
  });
  return withQuery(
    <DocumentTemplatesScreen organizationSlug="acme" organizationName="Acme" client={client} />,
  );
}

describe('DocumentTemplatesScreen', () => {
  it('lists templates with their purpose and is accessible', async () => {
    const { container } = render(
      screenOver([
        template('tpl-1', 'Kickoff brief', 'Start a kickoff'),
        template('tpl-2', 'Retro notes', 'Capture a retro'),
      ]),
    );

    const region = await screen.findByRole('region', { name: /document templates/i });
    const table = within(region).getByRole('table');
    const bodyRows = within(table).getAllByRole('row').slice(1);
    expect(bodyRows).toHaveLength(2);
    expect(within(bodyRows[0]!).getByRole('rowheader')).toHaveTextContent('Kickoff brief');
    expect(within(bodyRows[0]!)).toBeTruthy();
    expect(within(table).getByText('Start a kickoff')).toBeInTheDocument();

    await expectNoAxeViolations(container);
  });

  it('shows the empty state when there are no templates yet', async () => {
    render(screenOver([]));
    expect(await screen.findByText(/no templates yet/i)).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('applies a template and links to the new document', async () => {
    render(screenOver([template('tpl-1', 'Kickoff brief', 'Start a kickoff')]));
    const user = userEvent.setup();

    const applyButton = await screen.findByRole('button', { name: /apply/i });
    await user.click(applyButton);

    const link = await screen.findByRole('link', { name: /open/i });
    expect(link).toHaveAttribute('href', '/acme/docs/doc-new/edit');
  });
});
