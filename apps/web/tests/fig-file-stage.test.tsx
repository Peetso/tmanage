import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it } from 'vitest';
import { FigFileStage } from '../src/components/viewer/FigFileStage';
import { stageFor } from '../src/components/viewer/FileViewer';
import { ApiClient } from '../src/lib/api/client';
import type { FilePreviewManifest, PreviewFig } from '../src/lib/api/file-preview';

/**
 * Peter, 2026-11-10 (FIGMA item 10) — a `.fig` file in the viewer: the picture saved in it and
 * its pages, labelled as what they are; the team pairs a Figma link; the client sees "Show it
 * from Figma" only when one is paired, and nothing to connect.
 */

const BASE = 'https://api.test';

const FIG: PreviewFig = {
  fileName: 'Atlas app',
  frameCount: 3,
  truncated: true,
  pages: [
    {
      name: 'Mobile',
      frameCount: 2,
      frames: [
        { name: 'Login', width: 390, height: 844, x: 0, y: 0, section: null },
        { name: 'Cart', width: 390, height: 900, x: 500, y: 0, section: 'Checkout' },
      ],
    },
    { name: 'Desktop', frameCount: 1, frames: [] },
  ],
};

function link(id: string, attachedToId: string | null) {
  return {
    id,
    projectId: 'p1',
    fileName: `Design ${id}`,
    audience: 'client_visible',
    attachedToType: attachedToId ? 'file_asset' : null,
    attachedToId,
    openUrl: null,
    createdAt: '2026-11-10T10:00:00.000Z',
    focusFrameId: null,
    frameCount: 12,
  };
}

function fakeApi(links: readonly ReturnType<typeof link>[]) {
  const calls: string[] = [];
  const client = new ApiClient({
    baseUrl: BASE,
    csrfCookieName: 'tm_session_csrf',
    fetch: ((input: RequestInfo | URL) => {
      const url = String(input);
      calls.push(url);
      // The server filters by the pairing; the fake does the same.
      const attachedToId = new URL(url).searchParams.get('attachedToId');
      const shown = links.filter(
        (item) => attachedToId === null || item.attachedToId === attachedToId,
      );
      return Promise.resolve(
        new Response(JSON.stringify({ links: shown }), {
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
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

function manifest(overrides: Partial<FilePreviewManifest>): FilePreviewManifest {
  return {
    media: null,
    file: { id: 'f1', name: 'Atlas.fig', projectId: 'p1' },
    version: {
      fileVersionId: 'fv1',
      mimeType: 'application/x-figma',
      sizeBytes: 10,
      scanStatus: 'clean',
    },
    kind: 'fig',
    status: 'ready',
    derivatives: [],
    originalUrl: '/v1/organizations/o/files/f1/content',
    pages: null,
    durationMs: null,
    approximate: false,
    linkedImagesRemoved: false,
    embeddedPreview: true,
    psd: null,
    zip: null,
    fig: FIG,
    office: null,
    versions: { rootFileAssetId: 'f1', versions: [] },
    decisionContext: { kind: 'file', deliverableId: null, deliverableVersionId: null },
    capabilities: {
      canComment: true,
      canDraw: true,
      canResolve: true,
      canDecide: true,
      canUploadVersion: true,
      canDownload: true,
      canRetry: false,
      canDelete: false,
    },
    ...overrides,
  } as FilePreviewManifest;
}

describe('a .fig file in the viewer', () => {
  it('goes to the .fig stage with the saved picture, or with the list alone', () => {
    const preview = {
      id: 'd1',
      kind: 'preview',
      pageNo: 0,
      url: '/v1/organizations/o/files/f1/preview/d1/content',
      mimeType: 'image/webp',
      width: 400,
      height: 225,
    };
    expect(stageFor(manifest({ derivatives: [preview] as never }))).toEqual({
      stage: 'fig',
      state: null,
      src: preview.url,
    });
    expect(stageFor(manifest({}))).toEqual({ stage: 'fig', state: null, src: null });
    expect(stageFor(manifest({ fig: null, status: 'failed' })).state).toBe('failed');
  });

  it('team: the picture labelled as the one saved in the file, the pages, and a way to pair a link', async () => {
    const { client, calls } = fakeApi([]);
    render(
      withQuery(
        <FigFileStage
          organizationSlug="northstar"
          fileAssetId="f1"
          projectId="p1"
          fileName="Atlas.fig"
          picture="https://api.test/pic.webp"
          fig={FIG}
          door="studio"
          canAttach
          client={client}
        />,
      ),
    );
    expect(screen.getByRole('img', { name: 'Preview Figma saved inside Atlas.fig' })).toBeVisible();
    expect(screen.getByText('Small preview saved inside the file')).toBeInTheDocument();
    expect(screen.getByText(/Paste the file's Figma link/u)).toBeInTheDocument();
    expect(screen.getByText('Mobile · 2 frames')).toBeInTheDocument();
    expect(screen.getByText('Checkout › Cart')).toBeInTheDocument();
    expect(screen.getByText('This file has more frames than are listed here.')).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: 'Attach Figma link' })).toBeInTheDocument();
    expect(calls[0]).toContain(
      '/projects/p1/figma/links?attachedToType=file_asset&attachedToId=f1',
    );
  });

  it('client: "Show it from Figma" only for the link paired with this file; nothing to connect', async () => {
    const { client, calls } = fakeApi([
      link('l1', 'f1'),
      link('l2', 'other-file'),
      link('l3', null),
    ]);
    render(
      withQuery(
        <FigFileStage
          organizationSlug="northstar"
          fileAssetId="f1"
          projectId="p1"
          fileName="Atlas.fig"
          picture={null}
          fig={FIG}
          door="portal"
          canAttach={false}
          client={client}
        />,
      ),
    );
    const open = await screen.findByRole('link', { name: 'Show it from Figma' });
    expect(open).toHaveAttribute('href', '/northstar/portal/figma/l1');
    expect(calls[0]).toContain(
      '/portal/projects/p1/figma/links?attachedToType=file_asset&attachedToId=f1',
    );
    const section = open.closest('section');
    expect(section && within(section).getAllByRole('link')).toHaveLength(1);
    expect(
      screen.getByText('This file has no preview picture saved inside it.'),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Paste the file's Figma link/u)).toBeNull();
    expect(screen.queryByText(/Connect|Integrations|account/u)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Attach Figma link' })).toBeNull();
  });
});
