import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { describe, expect, it } from 'vitest';
import { DocumentEditorScreen } from '../src/components/screens/DocumentEditorScreen';
import { DocsHubScreen } from '../src/components/screens/DocsHubScreen';
import {
  applyDocEdit,
  diffLines,
  DOC_TOOL_EDITS,
  slashTriggerAt,
} from '../src/components/docs/doc-markdown';
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
  // Live test 2026-10-31 — Bold left the caret after "text", so "boldword" landed beside it.
  it('selects an inserted placeholder so the next word replaces it', () => {
    const bold = applyDocEdit('', 0, 0, DOC_TOOL_EDITS.bold, 'text');
    expect(bold).toEqual({ text: '**text**', selectionStart: 2, caret: 6 });
    const link = applyDocEdit('', 0, 0, DOC_TOOL_EDITS.link, 'text');
    expect(link.text.slice(link.selectionStart, link.caret)).toBe('text');
    // With a selection the caret goes after it, nothing selected.
    const wrapped = applyDocEdit('a b', 2, 3, DOC_TOOL_EDITS.bold);
    expect(wrapped.selectionStart).toBe(wrapped.caret);
  });

  // Live test 2026-10-31 — words typed straight after a toolbar click were lost ("- - - - **text**").
  it('keeps the focus in the body after a toolbar click, so typing goes into the doc', async () => {
    render(editor());
    const body = (await screen.findByLabelText('Document body')) as HTMLTextAreaElement;
    const user = userEvent.setup();
    await user.click(body);
    await user.click(screen.getByRole('button', { name: 'B' }));
    await waitFor(() => expect(document.activeElement).toBe(body));
    await user.keyboard('bold words');
    expect(body.value).toBe('**bold words**');
    await user.click(screen.getByRole('button', { name: /List/ }));
    await waitFor(() => expect(document.activeElement).toBe(body));
    await user.keyboard(' more');
    // The caret stays where it was (inside the bold), one marker further on.
    expect(body.value).toBe('- **bold words more**');
  });

  // Live test 2026-10-31 — "/" only typed a slash although the placeholder promised a menu.
  it('opens the "/" menu at the start of a line and inserts the chosen block', async () => {
    render(editor());
    const body = (await screen.findByLabelText('Document body')) as HTMLTextAreaElement;
    const user = userEvent.setup();
    await user.click(body);
    await user.keyboard('/');
    const menu = await screen.findByRole('listbox', { name: 'Insert a block' });
    expect(menu).toBeVisible();
    expect(screen.getAllByRole('option').map((option) => option.textContent)).toEqual([
      'H1Heading 1',
      'H2Heading 2',
      '•Bulleted list',
      '☐Checklist',
      '↗Link',
    ]);
    await user.keyboard('chec');
    expect(screen.getAllByRole('option')).toHaveLength(1);
    await user.keyboard('{Enter}');
    expect(body.value).toBe('- [ ] ');
    expect(screen.queryByRole('listbox')).toBeNull();
    // A slash inside a word never opens it; Esc closes it and keeps the slash.
    await user.keyboard('a/');
    expect(screen.queryByRole('listbox')).toBeNull();
    await user.keyboard(' /');
    expect(await screen.findByRole('listbox')).toBeVisible();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(body.value).toBe('- [ ] a/ /');
  });

  it('only a slash at a line start or after a space opens the menu', () => {
    expect(slashTriggerAt('/', 1)).toBe(0);
    expect(slashTriggerAt('one\n/', 5)).toBe(4);
    expect(slashTriggerAt('see /', 5)).toBe(4);
    expect(slashTriggerAt('and/', 4)).toBe(-1);
    expect(slashTriggerAt('https:/', 7)).toBe(-1);
  });

  // Live test 2026-10-31 — Share only flipped to "Link copied"; nothing said who can see the doc.
  it('Share opens the share dialog, which says who can see the doc and closes with Done', async () => {
    const { container } = render(editor());
    await screen.findByLabelText('Document body');
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
