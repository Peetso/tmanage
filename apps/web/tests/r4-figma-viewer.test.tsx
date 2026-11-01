import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it } from 'vitest';
import { AttachFigmaDialog, defaultFrameChoice } from '../src/components/viewer/FigmaLinks';
import {
  FigmaStage,
  frameChangedSince,
  hasPendingSnapshots,
  threadsForRail,
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
    snapshotStatus: 'ready',
    snapshotPath: '/figma/frames/fr1/snapshot?v=abc123abc123',
    capturedAt: '2026-11-01T09:00:00.000Z',
    sizeChanged: false,
    openThreads: 1,
    embedUrl: 'https://embed.figma.com/design/KEY?node-id=1-2&embed-host=tmanage',
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
    frames: [frame(), frame({ id: 'fr2', nodeId: '1:3', name: 'Home', sizeChanged: true })],
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
  const calls: { method: string; url: string }[] = [];
  const client = new ApiClient({
    baseUrl: BASE,
    csrfCookieName: 'tm_session_csrf',
    fetch: ((input: RequestInfo | URL, init?: RequestInit) => {
      const call = { method: init?.method ?? 'GET', url: String(input) };
      calls.push(call);
      let body: unknown = {};
      if (call.url.includes('/review/threads')) {
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
    }));
    expect([
      ...defaultFrameChoice({ fileName: 'x', linkedNodeId: '1:7', frames, maxFrames: 20 }),
    ]).toEqual(['1:7']);
    expect(
      defaultFrameChoice({ fileName: 'x', linkedNodeId: null, frames, maxFrames: 20 }).size,
    ).toBe(20);
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
    expect(screen.getByRole('link', { name: 'Connect Figma in Connected apps' })).toHaveAttribute(
      'href',
      '/northstar/settings/connected-apps',
    );
  });
});
