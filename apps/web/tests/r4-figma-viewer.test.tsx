import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it } from 'vitest';
import {
  AttachFigmaDialog,
  attachInputFor,
  defaultFrameChoice,
} from '../src/components/viewer/FigmaLinks';
import { pageFitZoom, pageLayout } from '../src/components/viewer/FigmaPageCanvas';
import {
  FigmaStage,
  frameChangedSince,
  frameOnStage,
  framesByPage,
  framesForViewer,
  hasPendingSnapshots,
  readEmbedMessage,
  threadsForRail,
  wantsSharp,
} from '../src/components/viewer/FigmaStage';
import { ApiClient } from '../src/lib/api/client';
import { ApiRequestError } from '../src/lib/api/errors';
import { figmaProblem, type FigmaFrame, type FigmaLink } from '../src/lib/api/figma';
import type { ReviewThread } from '../src/lib/api/review';

/**
 * R4 slice 13 — the Figma link viewer over a fake API: the snapshot with its pins and the frame
 * strip, "Frame changed", Live mode for the team, snapshots only for a client, and the attach
 * dialog's "not connected" refusal.
 */

const BASE = 'https://api.example.test';

function frame(overrides: Partial<FigmaFrame> = {}): FigmaFrame {
  return {
    id: 'fr1',
    nodeId: '1:2',
    name: 'Booking · Mobile',
    width: 390,
    height: 844,
    pageId: '0:1',
    pageName: 'Mobile',
    sectionName: null,
    x: 0,
    y: 0,
    snapshotStatus: 'ready',
    snapshotPath: '/figma/frames/fr1/snapshot?v=abc123abc123',
    thumbPath: '/figma/frames/fr1/thumb?v=abc123abc123',
    sharpPath: '/figma/frames/fr1/render?v=abc123abc123',
    sharpScale: 4,
    capturedAt: '2026-11-01T09:00:00.000Z',
    sizeChanged: false,
    gone: false,
    openThreads: 1,
    embedUrl: 'https://embed.figma.com/design/KEY?node-id=1-2&embed-host=tmanage',
    snapshotError: null,
    ...overrides,
  };
}

function link(overrides: Partial<FigmaLink> = {}): FigmaLink {
  return {
    id: 'l1',
    projectId: 'p1',
    fileName: 'Atlas booking',
    audience: 'client_visible',
    attachedToType: 'work_item',
    attachedToId: 'w1',
    openUrl: 'https://www.figma.com/design/KEY',
    createdAt: '2026-10-31T10:00:00.000Z',
    focusFrameId: null,
    pages: [{ id: '0:1', name: 'Mobile', frameCount: 2, readyCount: 2, selected: true }],
    capture: {
      mode: 'whole_file',
      pageCount: 1,
      frameCount: 2,
      ready: 2,
      pending: 0,
      failed: 0,
      skipped: 0,
      gone: 0,
      maxFrames: 250,
      overLimit: false,
      truncated: false,
      syncedAt: '2026-10-31T10:00:00.000Z',
    },
    frames: [frame(), frame({ id: 'fr2', nodeId: '1:3', name: 'Home', sizeChanged: true, x: 500 })],
    capabilities: { canComment: true, canRefresh: true, canRemove: true, canLive: true },
    ...overrides,
  };
}

function thread(overrides: Partial<ReviewThread> = {}): ReviewThread {
  return {
    id: 't1',
    number: 1,
    subjectType: 'figma_frame',
    subjectId: 'fr1',
    fileVersionId: null,
    anchorKind: 'pin',
    anchor: { x: 0.5, y: 0.5 },
    pageNo: null,
    timeMs: null,
    audience: 'client_visible',
    status: 'open',
    createdBy: { membershipId: 'm1', displayName: 'Maya Hassan', kind: 'internal' },
    createdAt: '2026-10-31T11:00:00.000Z',
    resolvedBy: null,
    resolvedAt: null,
    carriedFromThreadId: null,
    comments: [
      {
        id: 'c1',
        threadId: 't1',
        body: 'Move the price up.',
        mentions: [],
        author: { membershipId: 'm1', displayName: 'Maya Hassan', kind: 'internal' },
        createdAt: '2026-10-31T11:00:00.000Z',
        editedAt: null,
        canEdit: true,
        canDelete: true,
      },
    ],
    canResolve: true,
    canMove: false,
    ...overrides,
  } as ReviewThread;
}

function fakeApi(view: FigmaLink, threads: readonly ReviewThread[] = [thread()]) {
  const calls: { method: string; url: string; body?: string }[] = [];
  const client = new ApiClient({
    baseUrl: BASE,
    csrfCookieName: 'tm_session_csrf',
    fetch: ((input: RequestInfo | URL, init?: RequestInit) => {
      const call = {
        method: init?.method ?? 'GET',
        url: String(input),
        ...(typeof init?.body === 'string' ? { body: init.body } : {}),
      };
      calls.push(call);
      let body: unknown = {};
      if (call.url.includes('/review/threads') && call.method === 'POST') {
        const id = /frames\/([^/]+)\/review/u.exec(call.url)?.[1] ?? '';
        body = thread({ id: `new-${id}`, subjectId: id });
      } else if (call.url.includes('/review/threads')) {
        const id = /frames\/([^/]+)\/review/u.exec(call.url)?.[1];
        body = { threads: threads.filter((item) => item.subjectId === id) };
      } else if (call.url.includes('/figma/links/')) body = view;
      return Promise.resolve(
        new Response(JSON.stringify(body), {
          status: 200,
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

describe('Figma viewer helpers (R4 slice 13)', () => {
  it('says "Frame changed" only for comments placed before a capture at another size', () => {
    const changed = frame({ sizeChanged: true, capturedAt: '2026-11-01T09:00:00.000Z' });
    expect(frameChangedSince(changed, thread({ createdAt: '2026-10-31T11:00:00.000Z' }))).toBe(
      true,
    );
    expect(frameChangedSince(changed, thread({ createdAt: '2026-11-01T10:00:00.000Z' }))).toBe(
      false,
    );
    expect(frameChangedSince(frame(), thread())).toBe(false);
  });

  it('lists this frame, every frame, or the resolved threads', () => {
    const byFrame = new Map([
      ['fr1', [thread()]],
      ['fr2', [thread({ id: 't2', subjectId: 'fr2', status: 'resolved' })]],
    ]);
    expect(threadsForRail(byFrame, 'fr1', 'frame').map((t) => t.id)).toEqual(['t1']);
    expect(threadsForRail(byFrame, 'fr1', 'all')).toHaveLength(2);
    expect(threadsForRail(byFrame, 'fr1', 'resolved').map((t) => t.id)).toEqual(['t2']);
  });

  it('keeps polling while a snapshot is being made', () => {
    expect(hasPendingSnapshots(link())).toBe(false);
    expect(hasPendingSnapshots(link({ frames: [frame({ snapshotStatus: 'pending' })] }))).toBe(
      true,
    );
  });

  it('ticks the linked frame, or the first ones up to the cap', () => {
    const frames = Array.from({ length: 25 }, (_, i) => ({
      nodeId: `1:${i}`,
      name: `F${i}`,
      width: 1,
      height: 1,
      pageName: null,
      sectionName: null,
    }));
    const base = { fileName: 'x', pages: [], truncated: false, maxFrames: 20 };
    expect([...defaultFrameChoice({ ...base, linkedNodeId: '1:7', frames })]).toEqual(['1:7']);
    expect(defaultFrameChoice({ ...base, linkedNodeId: null, frames }).size).toBe(20);
  });

  it('shows a client only what is or is being captured; the team sees every frame', () => {
    const frames = [
      frame(),
      frame({ id: 'p', snapshotStatus: 'pending' }),
      frame({ id: 'f', snapshotStatus: 'failed', snapshotError: 'no_access' }),
      frame({ id: 's', snapshotStatus: 'skipped' }),
      frame({ id: 'g', gone: true }),
    ];
    expect(framesForViewer(frames, true).map((item) => item.id)).toEqual(['fr1', 'p']);
    expect(framesForViewer(frames, false)).toHaveLength(5);
  });

  it('opens on the chosen frame, else the linked one, else the first', () => {
    const frames = [frame(), frame({ id: 'fr2' })];
    expect(frameOnStage(frames, null, 'fr2')?.id).toBe('fr2');
    expect(frameOnStage(frames, 'fr1', 'fr2')?.id).toBe('fr1');
    expect(frameOnStage(frames, 'gone', null)?.id).toBe('fr1');
    expect(frameOnStage([], null, null)).toBeNull();
  });

  it('groups frames by Figma page in the file order, others last', () => {
    const groups = framesByPage(
      [
        frame({ id: 'a', pageId: '0:2' }),
        frame({ id: 'b', pageId: null }),
        frame({ id: 'c', pageId: '0:1' }),
      ],
      [
        { id: '0:1', name: 'Mobile' },
        { id: '0:2', name: 'Desktop' },
        { id: '0:3', name: 'Empty' },
      ],
    );
    expect(groups.map((group) => [group.id, group.frames.map((item) => item.id)])).toEqual([
      ['0:1', ['c']],
      ['0:2', ['a']],
      [null, ['b']],
    ]);
  });

  it('asks for the sharper render only when the snapshot is shown past its own pixels', () => {
    expect(wantsSharp(1, 1)).toBe(false);
    expect(wantsSharp(1, 2)).toBe(true);
    expect(wantsSharp(1.5, 1)).toBe(true);
    expect(wantsSharp(0.5, 2)).toBe(false);
  });

  it("reads Figma embed messages only from Figma's origin", () => {
    expect(
      readEmbedMessage('https://embed.figma.com', {
        type: 'PRESENTED_NODE_CHANGED',
        data: { presentedNodeId: '1:3' },
      }),
    ).toEqual({ kind: 'node', nodeId: '1:3' });
    expect(readEmbedMessage('https://embed.figma.com', { type: 'INITIAL_LOAD' })).toEqual({
      kind: 'loaded',
    });
    expect(readEmbedMessage('https://evil.test', { type: 'INITIAL_LOAD' })).toBeNull();
    expect(readEmbedMessage('https://embed.figma.com', 'INITIAL_LOAD')).toBeNull();
  });

  it('lays a page out where its frames sit, and fits it', () => {
    const layout = pageLayout([
      frame({ x: -100, y: 0, width: 100, height: 200 }),
      frame({ id: 'b', x: 400, y: 50, width: 100, height: 200 }),
      frame({ id: 'c', x: null, y: null }),
    ]);
    expect(layout).toMatchObject({ minX: -100, minY: 0, width: 600, height: 250 });
    expect(layout?.frames).toHaveLength(2);
    expect(pageFitZoom({ width: 600, height: 250 }, { width: 300, height: 1000 })).toBe(0.5);
  });

  it('attaches the whole file without a frame list, or only the picked frames', () => {
    expect(attachInputFor(' u ', 'whole', new Set(['1:2']), 'internal', null)).toEqual({
      url: 'u',
      audience: 'internal',
      attachedTo: null,
    });
    expect(attachInputFor('u', 'some', new Set(['1:2']), 'internal', null).nodeIds).toEqual([
      '1:2',
    ]);
  });

  it('reads the Figma refusal from a 409', () => {
    const error = new ApiRequestError(409, 'conflict', 'Connect Figma first', 'c', [
      { field: 'figma', message: 'not_connected' },
    ]);
    expect(figmaProblem(error)).toBe('not_connected');
    expect(figmaProblem(new Error('x'))).toBeNull();
  });
});

describe('FigmaStage (R4 slice 13)', () => {
  it('shows the snapshot with its pins, the frame strip and "Frame changed"', async () => {
    const { client } = fakeApi(link());
    render(
      withQuery(
        <FigmaStage
          organizationSlug="northstar"
          organizationName="Northstar Studio"
          linkId="l1"
          client={client}
          apiBase={BASE}
        />,
      ),
    );
    const image = await screen.findByRole('img', { name: 'Booking · Mobile' });
    expect(image).toHaveAttribute(
      'src',
      `${BASE}/v1/organizations/northstar/figma/frames/fr1/snapshot?v=abc123abc123`,
    );
    expect(screen.getByRole('button', { name: /Home/u })).toBeInTheDocument();
    expect(screen.getAllByText('Frame changed').length).toBeGreaterThan(0);
    expect(screen.getByRole('link', { name: 'Open in Figma' })).toHaveAttribute(
      'href',
      'https://www.figma.com/design/KEY',
    );
    expect(await screen.findByText('Move the price up.')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Live' }));
    const embed = await screen.findByTitle('Booking · Mobile in Figma');
    expect(embed).toHaveAttribute(
      'src',
      'https://embed.figma.com/design/KEY?node-id=1-2&embed-host=tmanage',
    );
    expect(screen.getByText(/Switch to Snapshot to place pins/u)).toBeInTheDocument();
  });

  it('gives a client snapshots only, through the portal routes', async () => {
    const { client, calls } = fakeApi(
      link({
        openUrl: null,
        attachedToType: null,
        attachedToId: null,
        frames: [frame({ embedUrl: null, snapshotPath: '/portal/figma/frames/fr1/snapshot?v=a' })],
        capabilities: { canComment: true, canRefresh: false, canRemove: false, canLive: false },
      }),
    );
    render(
      withQuery(
        <FigmaStage
          organizationSlug="northstar"
          organizationName="Northstar Studio"
          linkId="l1"
          door="portal"
          client={client}
          apiBase={BASE}
          renderShell={(_header, body) => <div>{body}</div>}
        />,
      ),
    );
    await screen.findByRole('img', { name: 'Booking · Mobile' });
    expect(screen.queryByRole('button', { name: 'Live' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Refresh snapshots' })).toBeNull();
    expect(calls[0]?.url).toBe(`${BASE}/v1/organizations/northstar/portal/figma/links/l1`);
  });
});

describe('FigmaStage · whole file (2026-11-10)', () => {
  it('posts a comment on the frame on screen, never the one before a switch (B8)', async () => {
    const pending = (over: Partial<FigmaFrame>) =>
      frame({ snapshotStatus: 'pending', snapshotPath: null, sharpPath: null, ...over });
    const { client, calls } = fakeApi(
      link({
        frames: [pending({ name: 'Index' }), pending({ id: 'fr2', nodeId: '1:3', name: 'Work' })],
      }),
      [],
    );
    render(
      withQuery(
        <FigmaStage
          organizationSlug="northstar"
          organizationName="Northstar Studio"
          linkId="l1"
          client={client}
          apiBase={BASE}
        />,
      ),
    );
    // A general comment opened on the first frame…
    fireEvent.click(await screen.findByRole('button', { name: /Add comment/u }));
    expect(screen.getByText('Comment on Index')).toBeInTheDocument();
    // …is closed by switching frames, so it cannot follow to the next one.
    fireEvent.click(screen.getByRole('button', { name: /Work/u }));
    expect(screen.queryByText('Comment on Index')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Add comment/u }));
    expect(screen.getByText('Comment on Work')).toBeInTheDocument();
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Tighten the grid.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Post' }));
    await waitFor(() =>
      expect(calls.find((call) => call.method === 'POST')?.url).toContain(
        '/figma/frames/fr2/review/threads',
      ),
    );
  });

  it('tells a client calmly that a design is being prepared, and the team why it failed', async () => {
    const failed = frame({
      snapshotStatus: 'failed',
      snapshotPath: null,
      sharpPath: null,
      snapshotError: 'no_access',
    });
    const team = fakeApi(link({ frames: [failed] }));
    const { unmount } = render(
      withQuery(
        <FigmaStage
          organizationSlug="northstar"
          organizationName="Northstar Studio"
          linkId="l1"
          client={team.client}
          apiBase={BASE}
        />,
      ),
    );
    expect(await screen.findByText(/can no longer open the file/u)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
    unmount();

    const portal = fakeApi(
      link({
        frames: [frame({ snapshotStatus: 'pending', snapshotPath: null, embedUrl: null })],
        capabilities: { canComment: true, canRefresh: false, canRemove: false, canLive: false },
      }),
    );
    render(
      withQuery(
        <FigmaStage
          organizationSlug="northstar"
          organizationName="Northstar Studio"
          linkId="l1"
          door="portal"
          client={portal.client}
          apiBase={BASE}
          renderShell={(_header, body) => <div>{body}</div>}
        />,
      ),
    );
    expect(await screen.findByText('This design is being prepared')).toBeInTheDocument();
    expect(screen.queryByText(/Figma account/u)).toBeNull();
  });

  it('says how much of the file is ready, and opens a frame from the whole-page view', async () => {
    const { client } = fakeApi(link());
    render(
      withQuery(
        <FigmaStage
          organizationSlug="northstar"
          organizationName="Northstar Studio"
          linkId="l1"
          client={client}
          apiBase={BASE}
        />,
      ),
    );
    expect(await screen.findByText(/2 of 2 frames ready/u)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Whole page' }));
    const canvas = screen.getByRole('group', { name: 'The whole page' });
    expect(canvas.querySelectorAll('.tm-figma-page__frame')).toHaveLength(2);
    fireEvent.click(screen.getByTitle('Open Home'));
    expect(await screen.findByRole('img', { name: 'Home' })).toBeInTheDocument();
  });
});

describe('AttachFigmaDialog (R4 slice 13)', () => {
  it('sends a person who has not connected Figma to Connected apps', async () => {
    const client = new ApiClient({
      baseUrl: BASE,
      csrfCookieName: 'tm_session_csrf',
      fetch: (() =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              error: {
                code: 'conflict',
                message: 'Connect Figma first',
                correlationId: 'c',
                details: [{ field: 'figma', message: 'not_connected' }],
              },
            }),
            { status: 409, headers: { 'content-type': 'application/json' } },
          ),
        )) as typeof globalThis.fetch,
      readCsrfToken: () => 'csrf-token',
      newCorrelationId: () => 'correlation-fixed',
    });
    render(
      withQuery(
        <AttachFigmaDialog
          api={client}
          organizationSlug="northstar"
          projectId="p1"
          target={null}
          onClose={() => undefined}
          onAttached={() => undefined}
        />,
      ),
    );
    fireEvent.change(screen.getByLabelText('Figma link'), {
      target: { value: 'https://www.figma.com/design/KEY/X' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Find frames' }));
    await waitFor(() => expect(screen.getByText('Figma is not connected')).toBeInTheDocument());
    expect(screen.getByRole('link', { name: 'Connect Figma in Integrations' })).toHaveAttribute(
      'href',
      '/northstar/automations/apps',
    );
  });
});
