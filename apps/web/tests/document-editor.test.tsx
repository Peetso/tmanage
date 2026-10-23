import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { describe, expect, it } from 'vitest';
import { DocumentEditorScreen } from '../src/components/screens/DocumentEditorScreen';
import { DocsHubScreen } from '../src/components/screens/DocsHubScreen';
import { applyDocEdit, DOC_TOOL_EDITS } from '../src/components/docs/doc-markdown';
import { ApiClient } from '../src/lib/api/client';
import { expectNoAxeViolations } from './axe';

/**
 * **A15 — the blank new doc (Figma 383:3806).**
 *
 * The API's version append, publish and relation checks are proved in `apps/api`. What only this
 * file can prove is what the screen does: a blank body shows the placeholder and "Or start from a
 * template"; the toolbar writes markdown at the selection; a pause in typing saves a version;
 * the docs column lists recent documents; and the hub's "New doc" creates a blank document.
 */

interface Call {
  readonly url: string;
  readonly method: string;
  readonly body: unknown;
}

function clientOver(handler: (call: Call) => Response, calls: Call[] = []): ApiClient {
  return new ApiClient({
    baseUrl: 'https://api.example.test',
    csrfCookieName: 'tm_session_csrf',
    fetch: ((input: RequestInfo | URL, init?: RequestInit) => {
      const call = {
        url: String(input),
        method: (init?.method ?? 'GET').toUpperCase(),
        body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
      };
      calls.push(call);
      return Promise.resolve(handler(call));
    }) as typeof globalThis.fetch,
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
const BLANK = {
  id: DOCUMENT_ID,
  projectId: 'proj-1',
  title: 'Atlas launch plan',
  body: '\n',
  createdByUserId: 'user-1',
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

function handler(call: Call): Response {
  if (call.url.includes('/recent-documents')) {
    return json({
      documents: [
        {
          id: DOCUMENT_ID,
          projectId: 'proj-1',
          projectName: 'Atlas relaunch',
          title: 'Atlas launch plan',
          updatedAt: BLANK.updatedAt,
          audience: 'internal',
          clientAudienceCount: 0,
        },
        {
          id: 'doc-2',
          projectId: 'proj-1',
          projectName: 'Atlas relaunch',
          title: 'Brand guidelines v2',
          updatedAt: BLANK.updatedAt,
          audience: 'internal',
          clientAudienceCount: 0,
        },
      ],
      hiddenCount: 0,
    });
  }
  if (call.url.endsWith('/projects'))
    return json({ projects: [{ id: 'proj-1', name: 'Atlas relaunch' }] });
  if (call.url.includes(`/documents/${DOCUMENT_ID}/sharing`)) {
    return json({
      audience: 'internal',
      publishedAt: null,
      clientAudienceCount: 0,
      collaborators: [],
      canPublish: true,
    });
  }
  if (call.url.includes(`/documents/${DOCUMENT_ID}/versions`)) {
    if (call.method === 'POST') {
      return json({
        id: 'v1',
        documentId: DOCUMENT_ID,
        versionNo: 1,
        body: 'x',
        editedByUserId: 'user-1',
        createdAt: new Date().toISOString(),
      });
    }
    return json({ versions: [] });
  }
  if (call.url.includes(`/documents/${DOCUMENT_ID}`)) return json(BLANK);
  if (call.url.endsWith('/documents') && call.method === 'POST') {
    return json({ ...BLANK, id: 'doc-new', title: 'Untitled doc' }, 201);
  }
  return json({}, 404);
}

function editor(calls: Call[] = []) {
  return withQuery(
    <DocumentEditorScreen
      organizationSlug="acme"
      organizationName="Acme"
      documentId={DOCUMENT_ID}
      client={clientOver(handler, calls)}
      autosaveDelayMs={20}
    />,
  );
}

describe('DocumentEditorScreen — the blank new doc', () => {
  it('shows the blank sheet as designed: placeholder, Draft, template link, recent docs', async () => {
    const { container } = render(editor());
    const body = await screen.findByLabelText('Document body');
    expect(body).toHaveValue('');
    expect(body).toHaveAttribute(
      'placeholder',
      'Start writing, or type / for headings, lists and checklists.',
    );
    expect(screen.getByRole('heading', { level: 2, name: 'Atlas launch plan' })).toBeVisible();
    expect(screen.getByText('Draft')).toBeVisible();
    expect(
      await screen.findByText('Atlas relaunch · Only you can see this draft until you share it'),
    ).toBeVisible();
    expect(screen.getByRole('link', { name: 'Or start from a template' })).toHaveAttribute(
      'href',
      '/acme/docs/templates',
    );
    expect(await screen.findByRole('link', { name: 'Brand guidelines v2' })).toBeVisible();
    expect(screen.getByRole('link', { name: 'Atlas launch plan' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    expect(screen.getByText('Saved · just now')).toBeVisible();
    expect(await screen.findByRole('button', { name: 'Publish' })).toBeVisible();
    await expectNoAxeViolations(container);
  });

  it('writes markdown from the toolbar and autosaves the pause as a version', async () => {
    const calls: Call[] = [];
    render(editor(calls));
    const body = await screen.findByLabelText('Document body');
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'H1' }));
    expect(body).toHaveValue('# ');
    await user.type(body, 'Goals');
    await user.click(screen.getByRole('button', { name: /Checklist/ }));
    expect((body as HTMLTextAreaElement).value).toContain('- [ ] ');
    await waitFor(() =>
      expect(calls.some((call) => call.method === 'POST' && call.url.endsWith('/versions'))).toBe(
        true,
      ),
    );
  });

  it('the toolbar edits wrap, prefix and link at the selection', () => {
    expect(applyDocEdit('a b', 2, 3, DOC_TOOL_EDITS.bold).text).toBe('a **b**');
    expect(applyDocEdit('one\ntwo', 4, 7, DOC_TOOL_EDITS.list).text).toBe('one\n- two');
    expect(applyDocEdit('', 0, 0, DOC_TOOL_EDITS.link, 'site').text).toBe('[site](https://)');
  });
});

describe('DocsHubScreen — New doc creates a blank document', () => {
  it('POSTs a blank document to the first project', async () => {
    const calls: Call[] = [];
    render(
      withQuery(
        <DocsHubScreen
          organizationSlug="acme"
          organizationName="Acme"
          client={clientOver(handler, calls)}
        />,
      ),
    );
    await userEvent.setup().click(await screen.findByRole('button', { name: /New doc/ }));
    await waitFor(() => {
      const create = calls.find(
        (call) => call.method === 'POST' && call.url.endsWith('/documents'),
      );
      expect(create?.body).toEqual({ projectId: 'proj-1', title: 'Untitled doc', body: '\n' });
    });
  });
});
