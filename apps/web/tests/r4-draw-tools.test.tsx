import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FileViewer } from '../src/components/viewer/FileViewer';
import { ApiClient } from '../src/lib/api/client';
import { activeLocale } from '../src/lib/i18n/locale-store';
import { expectNoAxeViolations } from './axe';

/**
 * R4 slice 7 — the Draw tool over a fake API: a saved drawing shows its strokes and its numbered
 * pin at the drawing's top-left; pen, arrow and rectangle strokes from mouse and touch; Undo;
 * Done opens the composer and posts `anchorKind: 'draw'` with relative points; a second finger
 * cancels a stroke (pinch); and the Arabic screen keeps the drawing where it is.
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

const MANIFEST = {
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
      width: 1000,
      height: 500,
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
    rootFileAssetId: 'f1',
    versions: [
      {
        versionNo: 2,
        fileAssetId: 'f1',
        fileName: 'homepage-hero-v2.png',
        createdAt: '2026-10-30T10:00:00.000Z',
        current: true,
      },
    ],
  },
  decisionContext: { kind: 'file', deliverableId: null, deliverableVersionId: null },
  capabilities: {
    canComment: true,
    canDraw: true,
    canResolve: true,
    canDecide: true,
    canUploadVersion: true,
    canDownload: true,
    canRetry: true,
    canDelete: false,
  },
};

function person(name: string) {
  return { membershipId: `m-${name}`, displayName: name, kind: 'internal' };
}

function thread(overrides: Record<string, unknown>) {
  return {
    id: 't1',
    number: 1,
    subjectType: 'file_asset',
    subjectId: 'f1',
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
    comments: [
      {
        id: 'c1',
        threadId: 't1',
        body: 'Keep the headline on one line.',
        mentions: [],
        author: person('Maya Hassan'),
        createdAt: '2026-10-31T11:40:00.000Z',
        editedAt: null,
        canEdit: false,
        canDelete: false,
      },
    ],
    canResolve: true,
    canMove: false,
    ...overrides,
  };
}

const THREADS = [
  thread({}),
  thread({
    id: 't3',
    number: 3,
    anchorKind: 'draw',
    anchor: {
      strokes: [
        {
          tool: 'pen',
          color: '#d9474f',
          width: 4,
          points: [
            [0.6, 0.3],
            [0.7, 0.35],
            [0.8, 0.32],
          ],
        },
        {
          tool: 'rect',
          color: '#7755c7',
          points: [
            [0.55, 0.6],
            [0.9, 0.8],
          ],
        },
      ],
      bbox: { x: 0.55, y: 0.3, w: 0.35, h: 0.5 },
    },
  }),
];

function fakeApi() {
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
      if (call.url.includes('/preview')) body = MANIFEST;
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

function renderViewer(api: ApiClient) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const wrap = (children: ReactNode) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  return render(
    wrap(
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

const SCREEN_BOX = {
  left: 0,
  top: 0,
  width: 1000,
  height: 500,
  right: 1000,
  bottom: 500,
  x: 0,
  y: 0,
} as DOMRect;

/** jsdom lays nothing out: the artwork (and the drawing layer over it) is 1000 × 500 on screen. */
function sizeTheArtwork() {
  const image = document.querySelector('img.tm-viewer-art__media') as HTMLImageElement;
  Object.defineProperty(image, 'naturalWidth', { value: 1000, configurable: true });
  Object.defineProperty(image, 'naturalHeight', { value: 500, configurable: true });
  fireEvent.load(image);
  (document.querySelector('.tm-viewer-art') as HTMLElement).getBoundingClientRect = () =>
    SCREEN_BOX;
}

function drawLayer() {
  const layer = screen.getByTestId('viewer-draw-layer');
  layer.getBoundingClientRect = () => SCREEN_BOX;
  return layer;
}

function stroke(
  layer: Element,
  points: readonly (readonly [number, number])[],
  pointer: { pointerId?: number; pointerType?: string } = {},
) {
  const base = { pointerId: pointer.pointerId ?? 1, pointerType: pointer.pointerType ?? 'mouse' };
  const [first, ...rest] = points;
  fireEvent.pointerDown(layer, { ...base, button: 0, clientX: first![0], clientY: first![1] });
  for (const [x, y] of rest) fireEvent.pointerMove(layer, { ...base, clientX: x, clientY: y });
  const last = points[points.length - 1]!;
  fireEvent.pointerUp(layer, { ...base, button: 0, clientX: last[0], clientY: last[1] });
}

function postedThread(calls: readonly Call[]) {
  return calls.find((c) => c.method === 'POST' && c.url.endsWith('/files/f1/review/threads'));
}

afterEach(() => {
  act(() => activeLocale.set('en-US'));
});

describe('Draw tool (R4 slice 7)', () => {
  it("shows a saved drawing with its pin at the drawing's top-left", async () => {
    const { client } = fakeApi();
    const { container } = renderViewer(client);
    await screen.findByRole('img', { name: 'homepage-hero-v2.png' });
    sizeTheArtwork();

    const pin = await screen.findByRole('button', { name: 'Comment 3, open' });
    expect(pin.style.left).toBe('55%');
    expect(pin.style.top).toBe('30%');
    const saved = container.querySelector('.tm-viewer-draw__thread') as SVGGElement;
    expect(saved).not.toBeNull();
    expect(saved.querySelector('path.tm-viewer-draw__pen')?.getAttribute('fill')).toBe('#d9474f');
    const rect = saved.querySelector('rect')!;
    expect(rect.getAttribute('x')).toBe('550');
    expect(rect.getAttribute('y')).toBe('300');
    expect(rect.getAttribute('width')).toBe('350');
    expect(rect.getAttribute('stroke')).toBe('#7755c7');
    // The layer only takes the pointer while drawing.
    expect(drawLayer()).not.toHaveAttribute('data-active');
  });

  it('draws pen, arrow and rectangle strokes, undoes one, and posts the drawing', async () => {
    const { client, calls } = fakeApi();
    const { container } = renderViewer(client);
    await screen.findByRole('img', { name: 'homepage-hero-v2.png' });
    sizeTheArtwork();

    fireEvent.click(screen.getByRole('button', { name: 'Draw' }));
    const toolbar = screen.getByRole('toolbar', { name: 'Drawing tools' });
    expect(within(toolbar).getByRole('button', { name: 'Pen' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    // Seven colours and three widths.
    expect(within(toolbar).getAllByRole('radio')).toHaveLength(10);
    expect(within(toolbar).getByRole('button', { name: 'Done' })).toBeDisabled();
    expect(within(toolbar).getByRole('button', { name: 'Undo' })).toBeDisabled();
    const layer = drawLayer();
    expect(layer).toHaveAttribute('data-active', 'true');

    // Pen, in the default red at the thin width.
    stroke(layer, [
      [100, 100],
      [150, 120],
      [200, 110],
    ]);
    // Arrow, purple, thick.
    fireEvent.click(within(toolbar).getByRole('button', { name: 'Arrow' }));
    fireEvent.click(within(toolbar).getByRole('radio', { name: 'Purple' }));
    fireEvent.click(within(toolbar).getByRole('radio', { name: 'Thick' }));
    expect(within(toolbar).getByRole('radio', { name: 'Purple' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    stroke(layer, [
      [600, 400],
      [700, 350],
      [800, 250],
    ]);
    // A rectangle, then take it back with Undo.
    fireEvent.click(within(toolbar).getByRole('button', { name: 'Rectangle' }));
    stroke(layer, [
      [300, 300],
      [500, 450],
    ]);
    const draft = () => container.querySelector('.tm-viewer-draw__draft')!;
    expect(draft().querySelectorAll('path.tm-viewer-draw__pen')).toHaveLength(1);
    expect(draft().querySelectorAll('line')).toHaveLength(1);
    expect(draft().querySelectorAll('rect')).toHaveLength(1);
    fireEvent.click(within(toolbar).getByRole('button', { name: 'Undo' }));
    expect(draft().querySelectorAll('rect')).toHaveLength(0);

    // A tap with the arrow is a slip, not a mark.
    fireEvent.click(within(toolbar).getByRole('button', { name: 'Arrow' }));
    stroke(layer, [[50, 50]]);
    expect(draft().querySelectorAll('line')).toHaveLength(1);

    fireEvent.click(within(toolbar).getByRole('button', { name: 'Done' }));
    const dialog = await screen.findByRole('dialog', { name: 'New comment' });
    // The toolbar steps aside while the comment is written; the strokes stay on the page.
    expect(screen.queryByRole('toolbar', { name: 'Drawing tools' })).not.toBeInTheDocument();
    expect(draft().querySelectorAll('line')).toHaveLength(1);
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Write a comment' }), {
      target: { value: 'Point the arrow at the price.' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Post' }));

    await waitFor(() => {
      expect(postedThread(calls)?.body).toEqual({
        versionId: 'fv2',
        anchorKind: 'draw',
        anchor: {
          strokes: [
            {
              tool: 'pen',
              color: '#d9474f',
              width: 4,
              points: [
                [0.1, 0.2],
                [0.15, 0.24],
                [0.2, 0.22],
              ],
            },
            {
              tool: 'arrow',
              color: '#7755c7',
              width: 9,
              points: [
                [0.6, 0.8],
                [0.8, 0.5],
              ],
            },
          ],
        },
        pageNo: null,
        audience: 'internal',
        body: 'Point the arrow at the price.',
        mentions: [],
      });
    });
    await expectNoAxeViolations(container);
  });

  it('draws with one finger and cancels the stroke when a second finger lands', async () => {
    const { client, calls } = fakeApi();
    const { container } = renderViewer(client);
    await screen.findByRole('img', { name: 'homepage-hero-v2.png' });
    sizeTheArtwork();
    fireEvent.click(screen.getByRole('button', { name: 'Draw' }));
    const layer = drawLayer();

    stroke(
      layer,
      [
        [100, 100],
        [300, 200],
      ],
      { pointerType: 'touch', pointerId: 7 },
    );
    const paths = () => container.querySelector('.tm-viewer-draw__draft')!.querySelectorAll('path');
    expect(paths()).toHaveLength(1);

    // Pinch: finger one goes down, finger two follows — no stroke is kept.
    fireEvent.pointerDown(layer, {
      pointerId: 8,
      pointerType: 'touch',
      clientX: 400,
      clientY: 100,
    });
    fireEvent.pointerDown(layer, {
      pointerId: 9,
      pointerType: 'touch',
      clientX: 600,
      clientY: 300,
    });
    fireEvent.pointerMove(layer, { pointerId: 8, pointerType: 'touch', clientX: 380, clientY: 90 });
    fireEvent.pointerUp(layer, { pointerId: 8, pointerType: 'touch', clientX: 380, clientY: 90 });
    expect(paths()).toHaveLength(1);

    // Leaving the tool drops the unposted drawing.
    fireEvent.click(screen.getByRole('button', { name: 'Select' }));
    expect(paths()).toHaveLength(0);
    expect(postedThread(calls)).toBeUndefined();
  });

  it('keeps a drawing on the same spot in Arabic and names the tools in Arabic', async () => {
    const { client } = fakeApi();
    const { container } = renderViewer(client);
    await screen.findByRole('img', { name: 'homepage-hero-v2.png' });
    sizeTheArtwork();
    const before = container.querySelector('.tm-viewer-draw__thread rect')!.getAttribute('x');

    act(() => activeLocale.set('ar-EG'));
    const pin = await screen.findByRole('button', { name: 'التعليق 3، مفتوح' });
    expect(pin.style.left).toBe('55%');
    expect(container.querySelector('.tm-viewer-draw__thread rect')!.getAttribute('x')).toBe(before);
    expect(pin.closest('[dir]')).toHaveAttribute('dir', 'ltr');

    fireEvent.click(screen.getByRole('button', { name: 'رسم' }));
    const toolbar = screen.getByRole('toolbar', { name: 'أدوات الرسم' });
    // The bar mirrors with the reading direction; the artwork under it does not.
    expect(toolbar.closest('[dir]')).toHaveAttribute('dir', 'rtl');
    expect(within(toolbar).getByRole('button', { name: 'قلم' })).toBeInTheDocument();
    expect(within(toolbar).getByRole('button', { name: 'تم' })).toBeDisabled();
  });
});
