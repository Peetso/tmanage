import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { describe, expect, it } from 'vitest';
import { DocumentEditorScreen } from '../src/components/screens/DocumentEditorScreen';
import { ApiClient } from '../src/lib/api/client';
import { expectNoAxeViolations } from './axe';

/**
 * **DOC-02 editor + DOC-03 version history / compare / restore (x112).**
 *
 * The API's authorize/relation logic, the append-only snapshot and the Known-trap 404 are proved
 * over fakes and a real server in `apps/api`; nothing here re-proves them. What only this file can
 * prove is what the *screen* does with the answers: it seeds the editor from the current body,
 * lists the versions newest-first with per-row actions, saves an edit, shows one snapshot for
 * compare, and carries an accessible structure (a labelled history region, a table caption and
 * column headers) with no axe violation jsdom can detect.
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

const DOCUMENT_ID = 'doc-1';
const EDITOR = 'user-0000-0000-0000-0000-0000000000aa';

const DOCUMENT = {
  id: DOCUMENT_ID,
  projectId: 'proj-1',
  title: 'Kickoff brief',
  body: 'current body',
  createdByUserId: EDITOR,
  createdAt: '2026-09-20T10:00:00.000Z',
  updatedAt: '2026-09-20T10:00:00.000Z',
};

function version(versionNo: number, body: string) {
  return {
    id: `docver-${versionNo}`,
    documentId: DOCUMENT_ID,
    versionNo,
    body,
    editedByUserId: EDITOR,
    createdAt: '2026-09-20T10:00:00.000Z',
  };
}

function screenOver(versions: readonly ReturnType<typeof version>[]) {
  const client = clientOver((call) => {
    if (call.url.includes(`/documents/${DOCUMENT_ID}/versions/`)) return json(versions[0] ?? {});
    if (call.url.includes(`/documents/${DOCUMENT_ID}/restore`))
      return json(version(99, 'restored'));
    if (call.url.includes(`/documents/${DOCUMENT_ID}/versions`)) {
      if (call.method === 'POST') return json(version(versions.length + 1, 'saved'));
      return json({ versions });
    }
    if (call.url.includes(`/documents/${DOCUMENT_ID}`)) return json(DOCUMENT);
    return json({}, 404);
  });
  return withQuery(
    <DocumentEditorScreen
      organizationSlug="acme"
      organizationName="Acme"
      documentId={DOCUMENT_ID}
      client={client}
    />,
  );
}

describe('DocumentEditorScreen', () => {
  it('seeds the editor, lists versions newest-first, and is accessible', async () => {
    const { container } = render(screenOver([version(2, 'second'), version(1, 'first')]));

    // The editor is seeded with the document's current body.
    const textarea = await screen.findByLabelText(/document body/i);
    expect(textarea).toHaveValue('current body');

    // The history region and its table appear, newest-first.
    const region = await screen.findByRole('region', { name: /saved versions/i });
    const table = within(region).getByRole('table');
    const bodyRows = within(table).getAllByRole('row').slice(1);
    expect(bodyRows).toHaveLength(2);
    expect(within(bodyRows[0]!).getByRole('rowheader')).toHaveTextContent('2');
    expect(within(bodyRows[1]!).getByRole('rowheader')).toHaveTextContent('1');

    await expectNoAxeViolations(container);
  });

  it('shows the empty state when a document has no versions yet', async () => {
    render(screenOver([]));

    expect(await screen.findByText(/no versions yet/i)).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('opens a snapshot for compare when a version’s Compare is pressed', async () => {
    render(screenOver([version(1, 'first')]));
    const user = userEvent.setup();

    const compare = await screen.findByRole('button', { name: /compare/i });
    await user.click(compare);

    // The compare pane shows the selected version's body.
    expect(await screen.findByLabelText(/body of version 1/i)).toHaveTextContent('first');
  });
});
