import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FileViewer } from '../src/components/viewer/FileViewer';
import { ApiClient } from '../src/lib/api/client';
import { activeLocale } from '../src/lib/i18n/locale-store';
import { expectNoAxeViolations } from './axe';

/**
 * R4 slice 6 — the proofing viewer over a fake API: an image with numbered pins and a box, the
 * thread rail (a listbox), opening a thread from a pin, placing a new pin and posting it, the
 * Arabic screen keeping every pin where it is, and the "checking" state.
 */

vi.mock('../src/components/viewer/pdf-document', () => ({
  PDF_WORKER_PATH: '/pdf.worker.min.mjs',
  PDF_POINTS_TO_CSS: 96 / 72,
  loadPdfDocument: () => ({ promise: new Promise(() => undefined), cancel: () => undefined }),
}));

interface Call {
  method: string;
  url: string;
  body: unknown;
}

const BASE = 'https://api.example.test';

function manifest(overrides: Record<string, unknown> = {}) {
  return {
    file: { id: 'f1', name: 'homepage-hero-v2.png', projectId: 'p1' },
    version: { fileVersionId: 'fv2', mimeType: 'image/png', sizeBytes: 2048, scanStatus: 'clean' },
    kind: 'image',
    status: 'ready',
    derivatives: [
      {
        id: 'd1',
        kind: 'preview',
        pageNo: 0,
        url: '/v1/organizations/northstar/files/f1/preview/d1/content',
        mimeType: 'image/webp',
        width: 1440,
        height: 900,
      },
    ],
    originalUrl: '/v1/organizations/northstar/files/f1/content',
    pages: null,
    durationMs: null,
    approximate: false,
    linkedImagesRemoved: false,
    embeddedPreview: false,
    psd: null,
    zip: null,
    office: null,
    versions: {
      rootFileAssetId: 'f0',
      versions: [
        {
          versionNo: 2,
          fileAssetId: 'f1',
          fileName: 'homepage-hero-v2.png',
          createdAt: '2026-10-30T10:00:00.000Z',
          current: true,
        },
        {
          versionNo: 1,
          fileAssetId: 'f0',
          fileName: 'homepage-hero.png',
          createdAt: '2026-10-20T10:00:00.000Z',
          current: false,
        },
      ],
    },
    decisionContext: { kind: 'file', deliverableId: null, deliverableVersionId: null },
    capabilities: {
      canReview: true,
      canComment: true,
      canDraw: true,
      canResolve: true,
      canDecide: true,
      canUploadVersion: true,
      canDownload: true,
      canRetry: true,
      canDelete: false,
    },
    ...overrides,
  };
}

function person(name: string, kind: 'internal' | 'client' = 'internal') {
  return { membershipId: `m-${name}`, displayName: name, kind };
}

function comment(id: string, threadId: string, body: string, own = false) {
  return {
    id,
    threadId,
    body,
    mentions: [],
    author: own ? person('Omar Adel') : person('Youssef Kamal', 'client'),
    createdAt: '2026-10-31T11:40:00.000Z',
    editedAt: null,
    canEdit: own,
    canDelete: own,
  };
}

function thread(overrides: Record<string, unknown>) {
  return {
    id: 't1',
    number: 1,
    subjectType: 'file_asset',
    subjectId: 'f0',
    fileVersionId: 'fv2',
    anchorKind: 'pin',
    anchor: { x: 0.25, y: 0.4 },
    pageNo: null,
    timeMs: null,
    audience: 'internal',
    status: 'open',
    createdBy: person('Maya Hassan'),
    createdAt: '2026-10-31T10:12:00.000Z',
    resolvedBy: null,
    resolvedAt: null,
    carriedFromThreadId: null,
    comments: [comment('c1', 't1', 'Keep the headline on one line on desktop.')],
    canResolve: true,
    canMove: false,
    ...overrides,
  };
}

const THREADS = [
  thread({}),
  thread({
    id: 't2',
    number: 2,
    audience: 'client_visible',
    anchor: { x: 0.3, y: 0.7 },
    createdBy: person('Youssef Kamal', 'client'),
    comments: [
      comment('c2', 't2', 'Can the button say “Book your stay”?'),
      comment('c3', 't2', 'Yes, changing it.', true),
    ],
  }),
  thread({
    id: 't4',
    number: 4,
    anchorKind: 'box',
    anchor: { x: 0.1, y: 0.75, w: 0.8, h: 0.15 },
    comments: [comment('c4', 't4', 'Prices need “per night” after them.')],
  }),
  thread({
    id: 't5',
    number: 5,
    status: 'resolved',
    resolvedBy: person('Lina Samir'),
    anchor: { x: 0.05, y: 0.05 },
    comments: [comment('c5', 't5', 'Logo is too close to the menu.')],
  }),
];

function fakeApi(options: { manifest?: unknown } = {}) {
  const calls: Call[] = [];
  const client = new ApiClient({
    baseUrl: BASE,
    csrfCookieName: 'tm_session_csrf',
    fetch: ((input: RequestInfo | URL, init?: RequestInit) => {
      const call: Call = {
        method: init?.method ?? 'GET',
        url: String(input),
        body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
      };
      calls.push(call);
      let body: unknown = {};
      if (call.url.includes('/preview')) body = options.manifest ?? manifest();
      else if (call.url.includes('/review/threads') && call.method === 'GET') {
        body = { threads: THREADS };
      } else if (call.url.includes('/review/threads') && call.method === 'POST') {
        body = thread({ id: 't6', number: 6, comments: [] });
      } else if (call.url.includes('mention-candidates')) body = { candidates: [] };
      return Promise.resolve(
        new Response(JSON.stringify(body), {
          status: call.method === 'POST' ? 201 : 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    }) as typeof globalThis.fetch,
    readCsrfToken: () => 'csrf-token',
    newCorrelationId: () => 'correlation-fixed',
  });
  return { client, calls };
}

function withQuery(children: ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

function renderViewer(api: ApiClient) {
  return render(
    withQuery(
      <FileViewer
        organizationSlug="northstar"
        organizationName="Northstar Studio"
        fileId="f1"
        client={api}
        apiBase={BASE}
      />,
    ),
  );
}

/** jsdom lays nothing out: give the artwork a 1000 × 500 box on screen. */
function sizeTheArtwork() {
  const image = document.querySelector('img.tm-viewer-art__media') as HTMLImageElement;
  Object.defineProperty(image, 'naturalWidth', { value: 1440, configurable: true });
  Object.defineProperty(image, 'naturalHeight', { value: 900, configurable: true });
  fireEvent.load(image);
  const art = document.querySelector('.tm-viewer-art') as HTMLElement;
  art.getBoundingClientRect = () =>
    ({
      left: 0,
      top: 0,
      width: 1000,
      height: 500,
      right: 1000,
      bottom: 500,
      x: 0,
      y: 0,
    }) as DOMRect;
  return art;
}

afterEach(() => {
  act(() => activeLocale.set('en-US'));
});

describe('FileViewer (R4 slice 6)', () => {
  it('shows the image with numbered pins, a box, and the comments rail', async () => {
    const { client } = fakeApi();
    const { container } = renderViewer(client);

    const image = await screen.findByRole('img', { name: 'homepage-hero-v2.png' });
    expect(image).toHaveAttribute(
      'src',
      `${BASE}/v1/organizations/northstar/files/f1/preview/d1/content`,
    );
    expect(image).toHaveAttribute('crossorigin', 'use-credentials');
    sizeTheArtwork();

    expect(await screen.findByRole('button', { name: 'Comment 1, open' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Comment 5, resolved' })).toBeInTheDocument();
    expect(container.querySelectorAll('.tm-viewer-box')).toHaveLength(1);

    const list = screen.getByRole('listbox', { name: 'Comments on this file' });
    const options = within(list).getAllByRole('option');
    // Open first, then by number; the resolved one last.
    expect(options.map((o) => within(o).getByText(/^\d$/u).textContent)).toEqual([
      '1',
      '2',
      '4',
      '5',
    ]);
    expect(screen.getAllByText('3 open · 1 resolved').length).toBeGreaterThan(0);
    expect(within(list).getByText('Visible to client')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Download original/u })).toHaveAttribute(
      'href',
      `${BASE}/v1/organizations/northstar/files/f1/content`,
    );

    await expectNoAxeViolations(container);
  });

  it('opens a thread from its pin, with replies and Resolve', async () => {
    const { client, calls } = fakeApi();
    renderViewer(client);
    await screen.findByRole('img', { name: 'homepage-hero-v2.png' });
    sizeTheArtwork();

    fireEvent.click(await screen.findByRole('button', { name: 'Comment 2, open' }));
    expect(await screen.findByRole('heading', { name: 'Comment 2' })).toBeInTheDocument();
    expect(screen.getByText('Yes, changing it.')).toBeInTheDocument();
    expect(
      screen.getByText('Replies on this thread are visible to the client.'),
    ).toBeInTheDocument();
    // Edit / delete only on one's own reply.
    expect(screen.getAllByRole('button', { name: 'Edit' })).toHaveLength(1);

    fireEvent.click(screen.getByRole('button', { name: 'Resolve' }));
    await waitFor(() =>
      expect(
        calls.some((c) => c.method === 'POST' && c.url.endsWith('/review/threads/t2/resolve')),
      ).toBe(true),
    );
  });

  it('keyboard: the thread list is one tab stop and Enter opens the active thread', async () => {
    const { client } = fakeApi();
    renderViewer(client);
    const list = await screen.findByRole('listbox', { name: 'Comments on this file' });
    expect(list).toHaveAttribute('tabindex', '0');
    fireEvent.keyDown(list, { key: 'ArrowDown' });
    fireEvent.keyDown(list, { key: 'Enter' });
    expect(await screen.findByRole('heading', { name: 'Comment 2' })).toBeInTheDocument();
  });

  it('places a pin with the Pin tool and posts it as a team-only thread', async () => {
    const { client, calls } = fakeApi();
    renderViewer(client);
    await screen.findByRole('img', { name: 'homepage-hero-v2.png' });
    const art = sizeTheArtwork();

    fireEvent.click(screen.getByRole('button', { name: 'Pin' }));
    fireEvent.pointerDown(art, { button: 0, clientX: 250, clientY: 100, pointerId: 1 });
    fireEvent.pointerUp(art, { button: 0, clientX: 250, clientY: 100, pointerId: 1 });

    const dialog = await screen.findByRole('dialog', { name: 'New comment' });
    expect(within(dialog).getByRole('radio', { name: 'Team only' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Write a comment' }), {
      target: { value: 'Swap in the real terrace photo.' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Post' }));

    await waitFor(() => {
      const post = calls.find(
        (c) => c.method === 'POST' && c.url.endsWith('/files/f1/review/threads'),
      );
      expect(post?.body).toEqual({
        versionId: 'fv2',
        anchorKind: 'pin',
        anchor: { x: 0.25, y: 0.2 },
        pageNo: null,
        audience: 'internal',
        body: 'Swap in the real terrace photo.',
        mentions: [],
      });
    });
  });

  it('draws a box with the Box tool', async () => {
    const { client, calls } = fakeApi();
    renderViewer(client);
    await screen.findByRole('img', { name: 'homepage-hero-v2.png' });
    const art = sizeTheArtwork();

    fireEvent.click(screen.getByRole('button', { name: 'Box' }));
    fireEvent.pointerDown(art, { button: 0, clientX: 100, clientY: 100, pointerId: 1 });
    fireEvent.pointerMove(art, { clientX: 400, clientY: 300, pointerId: 1 });
    fireEvent.pointerUp(art, { button: 0, clientX: 400, clientY: 300, pointerId: 1 });

    const dialog = await screen.findByRole('dialog', { name: 'New comment' });
    fireEvent.click(within(dialog).getByRole('radio', { name: 'Visible to client' }));
    fireEvent.change(within(dialog).getByRole('textbox'), { target: { value: 'Prices' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Post' }));

    await waitFor(() => {
      const post = calls.find(
        (c) => c.method === 'POST' && c.url.endsWith('/files/f1/review/threads'),
      );
      expect(post?.body).toMatchObject({
        anchorKind: 'box',
        anchor: { x: 0.1, y: 0.2, w: 0.3, h: 0.4 },
        audience: 'client_visible',
      });
    });
  });

  it('keeps every pin on the same spot in Arabic: the artwork is never mirrored', async () => {
    const { client } = fakeApi();
    renderViewer(client);
    await screen.findByRole('img', { name: 'homepage-hero-v2.png' });
    sizeTheArtwork();
    const englishPin = await screen.findByRole('button', { name: 'Comment 1, open' });
    const englishLeft = englishPin.style.left;
    expect(englishLeft).toBe('25%');

    act(() => activeLocale.set('ar-EG'));
    const arabicPin = await screen.findByRole('button', { name: 'التعليق 1، مفتوح' });
    expect(arabicPin.style.left).toBe(englishLeft);
    expect(arabicPin.style.right).toBe('');
    expect(arabicPin.closest('[dir]')).toHaveAttribute('dir', 'ltr');
    expect(screen.getByRole('tab', { name: /التعليقات/u })).toBeInTheDocument();
  });

  it('says the file is being checked and holds the download until then', async () => {
    const { client } = fakeApi({
      manifest: manifest({
        status: 'pending',
        derivatives: [],
        originalUrl: null,
        version: {
          fileVersionId: 'fv2',
          mimeType: 'image/png',
          sizeBytes: 2048,
          scanStatus: 'pending_scan',
        },
      }),
    });
    renderViewer(client);
    expect(
      await screen.findByRole('heading', { name: 'Checking the file first' }),
    ).toBeInTheDocument();
    expect(screen.getByText('Preview after the virus check')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Download original/u })).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Pin' })).not.toBeInTheDocument();
  });

  it('offers Try again on a failed preview to the team', async () => {
    const { client, calls } = fakeApi({
      manifest: manifest({ status: 'failed', derivatives: [] }),
    });
    renderViewer(client);
    fireEvent.click(await screen.findByRole('button', { name: /Try again/u }));
    await waitFor(() =>
      expect(
        calls.some((c) => c.method === 'POST' && c.url.endsWith('/files/f1/preview/retry')),
      ).toBe(true),
    );
  });
});
