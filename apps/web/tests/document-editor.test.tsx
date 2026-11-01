import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Editor } from '@tiptap/core';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { DocumentEditorScreen } from '../src/components/screens/DocumentEditorScreen';
import { DocsHubScreen } from '../src/components/screens/DocsHubScreen';
import { diffLines } from '../src/components/docs/doc-markdown';
import { ApiClient } from '../src/lib/api/client';
import { expectNoAxeViolations } from './axe';

/**
 * **A15 — the blank new doc (Figma 383:3806).**
 *
 * The API's version append, publish and relation checks are proved in `apps/api`. What only this
 * file can prove is what the screen does: a blank body shows the placeholder and "Or start from a
 * template"; a pause in typing saves an HTML version; a 409 shows the "Newer version" banner;
 * "/" inserts blocks; presence shows who else is editing; the docs column lists recent documents;
 * and the hub's "New doc" creates a blank document.
 */

vi.mock('../src/lib/api/uploads', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  uploadProjectFile: vi.fn(() => Promise.resolve('file-1')),
}));

/** The Tiptap editor behind the body (Tiptap keeps it on its DOM node). */
async function bodyEditor(): Promise<Editor> {
  const body = (await screen.findByRole('textbox', { name: 'Document body' })) as HTMLElement & {
    editor?: Editor;
  };
  await waitFor(() => expect(body.editor).toBeDefined());
  return body.editor as Editor;
}

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
  bodyFormat: 'markdown',
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
        versionNo: 2,
        body: 'x',
        bodyFormat: 'html',
        editedByUserId: 'user-1',
        createdAt: new Date().toISOString(),
      });
    }
    return json({ versions: [] });
  }
  if (call.url.endsWith('/presence')) return json({ editors: [] });
  if (call.url.includes(`/documents/${DOCUMENT_ID}`)) return json(BLANK);
  if (call.url.endsWith('/documents') && call.method === 'POST') {
    return json({ ...BLANK, id: 'doc-new', title: 'Untitled doc' }, 201);
  }
  return json({}, 404);
}

function screenOver(over: (call: Call) => Response, calls: Call[] = []) {
  return withQuery(
    <DocumentEditorScreen
      organizationSlug="acme"
      organizationName="Acme"
      documentId={DOCUMENT_ID}
      client={clientOver(over, calls)}
      autosaveDelayMs={20}
    />,
  );
}

const editor = (calls: Call[] = []) => screenOver(handler, calls);

describe('DocumentEditorScreen — the blank new doc', () => {
  it('shows the blank sheet as designed: placeholder, Draft, template link, recent docs', async () => {
    const { container } = render(editor());
    expect((await bodyEditor()).isEmpty).toBe(true);
    expect(container.querySelector('[data-placeholder]')).toHaveAttribute(
      'data-placeholder',
      'Start writing, or type / for headings, tables, images and more.',
    );
    expect(screen.getByRole('heading', { level: 2, name: 'Atlas launch plan' })).toBeVisible();
    expect(screen.getByText('Draft')).toBeVisible();
    expect(
      await screen.findByText(
        'Atlas relaunch · Your team can see this draft · clients only after you publish',
      ),
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

  it('autosaves the pause as an HTML version', async () => {
    const calls: Call[] = [];
    render(editor(calls));
    const ed = await bodyEditor();
    act(() => {
      ed.commands.insertContent('Goals');
    });
    await waitFor(() =>
      expect(calls.find((c) => c.method === 'POST' && c.url.endsWith('/versions'))?.body).toEqual({
        body: '<p dir="auto">Goals</p>',
        format: 'html',
      }),
    );
  });

  it('a 409 shows the "Newer version" banner and Reload refetches the document', async () => {
    const calls: Call[] = [];
    const stale = (call: Call): Response =>
      call.method === 'POST' && call.url.endsWith('/versions')
        ? json({ error: { code: 'conflict', message: 'Newer version' } }, 409)
        : handler(call);
    render(screenOver(stale, calls));
    const ed = await bodyEditor();
    act(() => {
      ed.commands.insertContent('Mine');
    });
    expect(await screen.findByRole('alert')).toHaveTextContent('Newer version');
    expect(screen.getByText('Not saved · newer version')).toBeVisible();
    const reads = () => calls.filter((c) => c.url.endsWith(`/documents/${DOCUMENT_ID}`)).length;
    const before = reads();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Reload' }));
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
    expect(reads()).toBe(before + 1);
  });

  it('"/tab" then Enter inserts a table', async () => {
    render(editor());
    const ed = await bodyEditor();
    act(() => {
      ed.commands.insertContent('/tab');
    });
    const row = await screen.findByRole('option', { name: /Table/ });
    expect(row).toHaveAttribute('aria-selected', 'true');
    fireEvent.keyDown(ed.view.dom, { key: 'Enter' });
    await waitFor(() => expect(ed.getHTML()).toContain('<table'));
  });

  it('shows who else is editing from the presence read', async () => {
    const sara = { userId: 'user-9', name: 'Sara Haddad', lastSeenAt: BLANK.updatedAt };
    render(
      screenOver((call) =>
        call.url.endsWith('/presence') ? json({ editors: [sara] }) : handler(call),
      ),
    );
    expect(await screen.findByText('Sara Haddad is editing')).toBeVisible();
  });

  // Live test 2026-10-31 — Share only flipped to "Link copied"; nothing said who can see the doc.
  it('Share opens the share dialog, which says who can see the doc and closes with Done', async () => {
    const { container } = render(editor());
    await bodyEditor();
    const user = userEvent.setup();
    const share = screen.getByRole('button', { name: 'Share' });
    await user.click(share);
    const dialog = await screen.findByRole('dialog', { name: 'Share “Atlas launch plan”' });
    expect(dialog).toHaveTextContent('Your team · Atlas relaunch members — can edit');
    expect(dialog).toHaveTextContent('Client people · 0 — can read after you publish');
    await user.click(screen.getByRole('button', { name: 'Copy link' }));
    expect(await screen.findByRole('button', { name: 'Link copied' })).toBeVisible();
    await expectNoAxeViolations(container);
    await user.click(screen.getByRole('button', { name: 'Done' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(share);
  });

  // Live test 2026-10-31 — Compare showed the old text with no diff or label; Restore had no look first.
  it('compares a version with the current text and restores it from the compare card', async () => {
    const calls: Call[] = [];
    const earlier = new Date(Date.now() - 60_000).toISOString();
    const now = new Date().toISOString();
    const versions = [
      {
        id: 'v1',
        documentId: DOCUMENT_ID,
        versionNo: 1,
        body: 'Alpha\nOld line',
        editedByUserId: 'user-1',
        createdAt: earlier,
      },
      {
        id: 'v2',
        documentId: DOCUMENT_ID,
        versionNo: 2,
        body: 'Alpha\nNew line',
        editedByUserId: 'user-2',
        createdAt: now,
      },
    ];
    const withHistory = (call: Call): Response => {
      if (call.url.endsWith(`/documents/${DOCUMENT_ID}/versions`) && call.method === 'GET') {
        return json({ versions });
      }
      if (call.url.endsWith(`/documents/${DOCUMENT_ID}/versions/1`)) return json(versions[0]);
      if (call.url.endsWith(`/documents/${DOCUMENT_ID}/restore`)) {
        return json({ ...versions[0], id: 'v3', versionNo: 3 });
      }
      if (call.url.includes(`/documents/${DOCUMENT_ID}/sharing`)) {
        return json({
          audience: 'internal',
          publishedAt: null,
          clientAudienceCount: 0,
          collaborators: [
            { userId: 'user-1', displayName: 'Maya Hassan' },
            { userId: 'user-2', displayName: 'Omar Adel' },
          ],
          canPublish: true,
        });
      }
      if (call.url.endsWith(`/documents/${DOCUMENT_ID}`)) {
        return json({ ...BLANK, body: 'Alpha\nNew line' });
      }
      return handler(call);
    };
    render(
      withQuery(
        <DocumentEditorScreen
          organizationSlug="acme"
          organizationName="Acme"
          documentId={DOCUMENT_ID}
          client={clientOver(withHistory, calls)}
          autosaveDelayMs={20}
        />,
      ),
    );
    const user = userEvent.setup();
    await user.click(await screen.findByText('Version history · 2'));
    const current = await screen.findByRole('button', { name: /Current/ });
    expect(current).toBeDisabled();
    expect(current).toHaveTextContent('Omar Adel');
    expect(screen.queryByRole('button', { name: /^Restore/ })).toBeNull();
    await user.click(screen.getByRole('button', { name: /Maya Hassan/ }));
    const compare = await screen.findByRole('region', { name: 'Compare versions' });
    expect(compare).toHaveTextContent('2 changes');
    expect(compare).toHaveTextContent('AddedNew line');
    expect(compare).toHaveTextContent('RemovedOld line');
    expect(compare).toHaveTextContent('Restoring creates a new version. Nothing is overwritten.');
    await user.click(screen.getByRole('button', { name: /^Restore .* version$/ }));
    await waitFor(() =>
      expect(calls.find((call) => call.url.endsWith('/restore'))?.body).toEqual({ versionNo: 1 }),
    );
  });

  it('diffs lines into added and removed runs', () => {
    expect(diffLines('a\nb\nc', 'a\nc\nd')).toEqual([
      { kind: 'removed', lines: ['b'] },
      { kind: 'added', lines: ['d'] },
    ]);
    expect(diffLines('same', 'same')).toEqual([]);
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
