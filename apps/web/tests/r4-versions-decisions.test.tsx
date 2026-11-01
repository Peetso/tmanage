import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CarryForwardList, firstWords } from '../src/components/viewer/CarryForwardDialog';
import { CompareStage, comparePins } from '../src/components/viewer/CompareStage';
import { FileViewer, stageFor, threadsForVersion } from '../src/components/viewer/FileViewer';
import { ApiClient } from '../src/lib/api/client';
import type { FilePreviewManifest } from '../src/lib/api/file-preview';
import { capsuleStateFor } from '../src/lib/api/file-review-decisions';
import type { ReviewThread } from '../src/lib/api/review';
import { activeLocale } from '../src/lib/i18n/locale-store';
import { expectNoAxeViolations } from './axe';

/**
 * R4 slice 11 — versions, compare, carry-forward and decisions over a fake API: the Versions tab
 * with each version's state and counts, the decision card (a note is needed to ask for changes,
 * the POST body), the carry-forward list, the compare panes, the rail showing only the version on
 * screen, and the stage chosen for every format slices 9–10 added.
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
    file: { id: 'f1', name: 'homepage-concept-v2.png', projectId: 'p1' },
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
    media: null,
    versions: {
      rootFileAssetId: 'f0',
      versions: [
        {
          versionNo: 2,
          fileAssetId: 'f1',
          fileName: 'homepage-concept-v2.png',
          createdAt: '2026-10-30T10:00:00.000Z',
          current: true,
        },
        {
          versionNo: 1,
          fileAssetId: 'f0',
          fileName: 'homepage-concept.png',
          createdAt: '2026-10-20T10:00:00.000Z',
          current: false,
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
    },
    ...overrides,
  };
}

function person(name: string) {
  return { membershipId: `m-${name}`, displayName: name, kind: 'internal' };
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
    comments: [
      {
        id: 'c1',
        threadId: 't1',
        body: 'Keep the headline on one line on desktop.',
        mentions: [],
        author: person('Maya Hassan'),
        createdAt: '2026-10-31T10:12:00.000Z',
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
  // The same comment on v1, before it was carried to v2: not listed while v2 is on screen.
  thread({ id: 't0', fileVersionId: 'fv1' }),
];

function decisions(overrides: Record<string, unknown> = {}) {
  return {
    rootFileAssetId: 'f0',
    versions: [
      {
        fileAssetId: 'f1',
        versionNo: 2,
        state: 'in_review',
        openThreads: 1,
        resolvedThreads: 0,
        carriedThreads: 1,
        latestDecision: null,
      },
      {
        fileAssetId: 'f0',
        versionNo: 1,
        state: 'changes_requested',
        openThreads: 1,
        resolvedThreads: 0,
        carriedThreads: 0,
        latestDecision: {
          id: 'dec1',
          fileAssetId: 'f0',
          versionNo: 1,
          decision: 'changes_requested',
          note: 'Make the hero shorter.',
          decidedBy: { membershipId: 'm-y', displayName: 'Youssef Kamal', kind: 'client' },
          createdAt: '2026-10-25T09:00:00.000Z',
        },
      },
    ],
    history: [
      {
        id: 'dec1',
        fileAssetId: 'f0',
        versionNo: 1,
        decision: 'changes_requested',
        note: 'Make the hero shorter.',
        decidedBy: { membershipId: 'm-y', displayName: 'Youssef Kamal', kind: 'client' },
        createdAt: '2026-10-25T09:00:00.000Z',
      },
    ],
    ...overrides,
  };
}

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
      if (call.url.includes('/review/decisions') && call.method === 'POST') {
        body = decisions({
          versions: [
            {
              ...decisions().versions[0],
              state: 'approved',
              latestDecision: {
                id: 'dec2',
                fileAssetId: 'f1',
                versionNo: 2,
                decision: 'approved',
                note: null,
                decidedBy: { membershipId: 'm-o', displayName: 'Omar Adel', kind: 'internal' },
                createdAt: '2026-11-01T10:42:00.000Z',
              },
            },
            decisions().versions[1],
          ],
        });
      } else if (call.url.includes('/review/decisions')) body = decisions();
      else if (call.url.includes('/preview')) body = manifest();
      else if (call.url.includes('/review/threads') && call.method === 'GET') {
        body = { threads: THREADS };
      } else if (call.url.includes('/versions') && call.method === 'GET') {
        body = {
          rootFileAssetId: 'f0',
          versions: [{ fileAssetId: 'f1', versionNo: 2, note: 'Shorter hero, new button copy.' }],
        };
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

afterEach(() => {
  act(() => activeLocale.set('en-US'));
});

describe('Versions, compare, carry-forward and decisions (R4 slice 11)', () => {
  it('lists each version with its state, counts and decision in the Versions tab', async () => {
    const { client } = fakeApi();
    const { container } = renderViewer(client);
    await screen.findByRole('img', { name: 'homepage-concept-v2.png' });

    fireEvent.click(await screen.findByRole('tab', { name: /Versions/u }));
    const cards = await waitFor(() => {
      const found = container.querySelectorAll('.tm-versions-card');
      expect(found).toHaveLength(2);
      return found;
    });
    const newest = cards[0] as HTMLElement;
    expect(newest).toHaveAttribute('aria-current', 'page');
    expect(within(newest).getByText('In review')).toBeInTheDocument();
    expect(within(newest).getByText('1 open · 1 carried from v1')).toBeInTheDocument();
    const older = cards[1] as HTMLElement;
    expect(within(older).getByText('Changes requested')).toBeInTheDocument();
    expect(within(older).getByText(/Changes requested by Youssef Kamal/u)).toBeInTheDocument();
    expect(within(older).getByRole('button', { name: 'Compare with v2' })).toBeInTheDocument();

    await expectNoAxeViolations(container);
  });

  it('lists only the threads of the version on screen', async () => {
    const { client } = fakeApi();
    renderViewer(client);
    await screen.findByRole('img', { name: 'homepage-concept-v2.png' });
    const list = await screen.findByRole('listbox', { name: 'Comments on this file' });
    await waitFor(() => expect(within(list).getAllByRole('option')).toHaveLength(1));
  });

  it('asks for a note before requesting changes, then records the decision', async () => {
    const { client, calls } = fakeApi();
    renderViewer(client);
    await screen.findByRole('img', { name: 'homepage-concept-v2.png' });

    fireEvent.click(await screen.findByRole('button', { name: 'Request changes' }));
    fireEvent.click(screen.getByRole('button', { name: 'Send request' }));
    expect(await screen.findByText('A note is needed to request changes.')).toBeInTheDocument();
    expect(calls.some((c) => c.method === 'POST' && c.url.includes('/review/decisions'))).toBe(
      false,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Approve v2' }));
    await waitFor(() =>
      expect(
        calls.find((c) => c.method === 'POST' && c.url.includes('/review/decisions')),
      ).toMatchObject({
        url: `${BASE}/v1/organizations/northstar/files/f1/review/decisions`,
        body: { decision: 'approved' },
      }),
    );
    expect(await screen.findByText(/Omar Adel approved v2/u)).toBeInTheDocument();
  });

  it('a deliverable file sends the decision to the deliverable approval', async () => {
    const { client } = fakeApi();
    const view = manifest({
      decisionContext: { kind: 'deliverable', deliverableId: 'dl1', deliverableVersionId: 'dv1' },
    }) as unknown as FilePreviewManifest;
    const { DecisionRail } = await import('../src/components/viewer/DecisionRail');
    render(
      withQuery(
        <DecisionRail
          organizationSlug="northstar"
          manifest={view}
          review={undefined}
          pending={false}
          error={null}
          onDecide={() => undefined}
        />,
      ),
    );
    expect(screen.getByRole('link', { name: 'Open approval' })).toHaveAttribute(
      'href',
      '/northstar/projects/p1/deliverables/dl1',
    );
    expect(screen.queryByRole('button', { name: 'Approve v2' })).toBeNull();
    void client;
  });

  it('carry-forward: one checkbox per open comment, unticking calls back', () => {
    const toggled: string[] = [];
    const threads = [
      thread({}),
      thread({ id: 't3', number: 3 }),
    ] as unknown as readonly ReviewThread[];
    render(
      <CarryForwardList
        threads={threads}
        chosen={new Set(['t1', 't3'])}
        fromNo={2}
        toNo={3}
        onToggle={(id) => toggled.push(id)}
      />,
    );
    expect(screen.getByText('2 open comments on v2 — carry them to v3?')).toBeInTheDocument();
    const boxes = screen.getAllByRole('checkbox');
    expect(boxes).toHaveLength(2);
    fireEvent.click(boxes[1] as HTMLElement);
    expect(toggled).toEqual(['t3']);
    expect(firstWords('word '.repeat(40))).toMatch(/…$/u);
  });

  it('compare: two panes with their own pins, and overlay with the mix slider', async () => {
    const { client } = fakeApi();
    const view = manifest() as unknown as FilePreviewManifest;
    render(
      withQuery(
        <CompareStage
          api={client}
          organizationSlug="northstar"
          door="studio"
          apiBase={BASE}
          versions={view.versions.versions}
          threads={THREADS as unknown as readonly ReviewThread[]}
          review={decisions() as never}
          leftId="f0"
          rightId="f1"
          selectedThreadId={null}
          onSelectThread={() => undefined}
          onPick={() => undefined}
          onExit={() => undefined}
        />,
      ),
    );
    expect(screen.getByText('Comparing v1 with v2')).toBeInTheDocument();
    expect(await screen.findAllByRole('img', { name: /Version v/u })).toHaveLength(2);
    fireEvent.click(screen.getByRole('button', { name: 'Overlay' }));
    expect(screen.getByRole('slider', { name: 'Mix between the two versions' })).toHaveValue('50');
    expect(
      comparePins(THREADS as unknown as readonly ReviewThread[], view).map((t) => t.id),
    ).toEqual(['t1']);
  });

  it('picks a stage for every format the viewer knows', () => {
    const of = (overrides: Record<string, unknown>) =>
      stageFor(manifest(overrides) as unknown as FilePreviewManifest).stage;
    expect(of({})).toBe('image');
    expect(of({ kind: 'video', derivatives: [] })).toBe('video');
    expect(of({ kind: 'audio', derivatives: [] })).toBe('audio');
    expect(of({ kind: 'office_docx', derivatives: [] })).toBe('office_docx');
    expect(of({ kind: 'office_xlsx', derivatives: [] })).toBe('office_xlsx');
    expect(of({ kind: 'zip', derivatives: [], zip: { entries: [] } })).toBe('zip');
    expect(of({ kind: 'unsupported', derivatives: [] })).toBe('unsupported');
    expect(of({ kind: 'unsupported', embeddedPreview: true })).toBe('image');
    expect(of({ kind: 'psd' })).toBe('image');
    expect(capsuleStateFor('changes_requested')).toBe('waiting');
    expect(
      threadsForVersion(THREADS as unknown as readonly ReviewThread[], 'fv1').map((t) => t.id),
    ).toEqual(['t0']);
  });

  it('Arabic: the decision card reads right to left', async () => {
    act(() => activeLocale.set('ar-EG'));
    const { client } = fakeApi();
    renderViewer(client);
    await screen.findByRole('img', { name: 'homepage-concept-v2.png' });
    expect(await screen.findByRole('button', { name: 'اطلب تعديلات' })).toBeInTheDocument();
  });
});
