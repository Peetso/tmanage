import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { PortalFileViewerScreen } from '../src/components/screens/PortalFileViewerScreen';
import { FileViewer } from '../src/components/viewer/FileViewer';
import { ApiClient } from '../src/lib/api/client';

/**
 * 52-24 — with the `proofing` flag off the manifest says `canReview: false`: the viewer shows the
 * file, never asks for the comments (the route would answer 404) and shows no error for a feature
 * that is simply switched off. The client's door first, then the team's.
 */

vi.mock('../src/components/viewer/pdf-document', () => ({
  PDF_WORKER_PATH: '/pdf.worker.min.mjs',
  PDF_POINTS_TO_CSS: 96 / 72,
  loadPdfDocument: () => ({ promise: new Promise(() => undefined), cancel: () => undefined }),
}));

const BASE = 'https://api.example.test';

function manifest(door: 'portal' | 'studio') {
  const prefix = `/v1/organizations/northstar${door === 'portal' ? '/portal' : ''}/files/f1`;
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
        url: `${prefix}/preview/d1/content`,
        mimeType: 'image/webp',
        width: 1440,
        height: 900,
      },
    ],
    originalUrl: `${prefix}/content`,
    pages: null,
    durationMs: null,
    approximate: false,
    linkedImagesRemoved: false,
    versions: {
      rootFileAssetId: 'f1',
      versions: [
        {
          versionNo: 2,
          fileAssetId: 'f1',
          fileName: 'homepage-concept-v2.png',
          createdAt: '2026-10-30T10:00:00.000Z',
          current: true,
        },
      ],
    },
    decisionContext: { kind: 'file' },
    capabilities: {
      canReview: false,
      canComment: false,
      canDraw: false,
      canResolve: false,
      canDecide: false,
      canUploadVersion: door === 'studio',
      canDownload: true,
      canRetry: false,
      canDelete: false,
    },
  };
}

function fakeApi() {
  const urls: string[] = [];
  const client = new ApiClient({
    baseUrl: BASE,
    csrfCookieName: 'tm_session_csrf',
    fetch: ((input: RequestInfo | URL) => {
      const url = String(input);
      urls.push(url);
      const body = url.includes('/preview')
        ? manifest(url.includes('/portal/') ? 'portal' : 'studio')
        : {};
      return Promise.resolve(
        new Response(JSON.stringify(body), {
          status: url.includes('/review/threads') ? 404 : 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    }) as typeof globalThis.fetch,
    readCsrfToken: () => 'csrf-token',
    newCorrelationId: () => 'correlation-fixed',
  });
  return { client, urls };
}

function withQuery(ui: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{ui}</QueryClientProvider>;
}

async function expectCleanViewer(urls: readonly string[]) {
  expect(await screen.findByRole('img', { name: /homepage-concept-v2\.png/u })).toBeTruthy();
  await waitFor(() => expect(urls.some((url) => url.includes('/preview'))).toBe(true));
  expect(urls.some((url) => url.includes('/review/threads'))).toBe(false);
  expect(screen.queryByText('Comments could not be loaded')).toBeNull();
  expect(screen.queryByRole('button', { name: 'Add comment' })).toBeNull();
}

describe('52-24 file viewer with proofing off', () => {
  it('client portal: the file alone, no comments read, no error, no comments rail', async () => {
    const { client, urls } = fakeApi();
    render(
      withQuery(
        <PortalFileViewerScreen
          organizationSlug="northstar"
          fileId="f1"
          clientName="Seaside Hotels"
          providerName="Lumen Studio"
          client={client}
          apiBase={BASE}
          preview={false}
        />,
      ),
    );
    await expectCleanViewer(urls);
    expect(screen.queryByRole('heading', { name: 'Comments' })).toBeNull();
  });

  it('team view: the file and its Versions, no Comments tab, no comments read, no error', async () => {
    const { client, urls } = fakeApi();
    render(
      withQuery(
        <FileViewer
          organizationSlug="northstar"
          organizationName="Northstar Studio"
          fileId="f1"
          client={client}
          apiBase={BASE}
        />,
      ),
    );
    await expectCleanViewer(urls);
    expect(screen.queryByRole('tab', { name: /^Comments/u })).toBeNull();
    expect(screen.getByRole('tab', { name: /^Versions/u }).getAttribute('aria-selected')).toBe(
      'true',
    );
  });
});
