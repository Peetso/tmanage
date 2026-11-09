import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { FilesHubScreen } from '../src/components/screens/FilesHubScreen';
import { FileViewer } from '../src/components/viewer/FileViewer';
import { UndoToastHost } from '../src/components/undo/UndoToastHost';
import { ApiClient } from '../src/lib/api/client';
import { deleteFile, restoreFile } from '../src/lib/api/file-delete';

/**
 * FIX5 item 5 (live bug B-N5): uploaded files could not be deleted. The Files hub offers Delete on
 * the rows the API marks `canDelete`, asks first, sends `DELETE …/files/:id`, drops the row and
 * shows "File deleted · Undo"; Undo sends `POST …/files/:id/restore`.
 */

vi.mock('../src/components/viewer/pdf-document', () => ({
  PDF_WORKER_PATH: '/pdf.worker.min.mjs',
  PDF_POINTS_TO_CSS: 96 / 72,
  loadPdfDocument: () => ({ promise: new Promise(() => undefined), cancel: () => undefined }),
}));

function json(body: unknown, status = 200): Response {
  return new Response(status === 204 ? null : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function file(id: string, name: string, canDelete: boolean) {
  return {
    id,
    projectId: 'p1',
    name,
    mimeType: 'text/csv',
    sizeBytes: 42,
    audience: 'internal',
    purpose: 'message_attachment',
    versionNo: 1,
    updatedAt: '2026-11-09T10:00:00.000Z',
    scanStatus: 'clean',
    canDelete,
  };
}

function harness() {
  const calls: string[] = [];
  let deleted = false;
  const client = new ApiClient({
    baseUrl: 'https://api.example.test',
    csrfCookieName: 'tm_session_csrf',
    fetch: ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      if (method !== 'GET') {
        calls.push(`${method} ${url.replace('https://api.example.test', '')}`);
        if (method === 'DELETE') deleted = true;
        if (url.endsWith('/restore')) deleted = false;
        return Promise.resolve(json(null, 204));
      }
      if (url.includes('/projects/p1/files')) {
        const files = [file('f2', 'brief.csv', false)];
        if (!deleted) files.unshift(file('f1', 'quote.csv', true));
        return Promise.resolve(json({ files }));
      }
      return Promise.resolve(json({ projects: [{ id: 'p1', name: 'Atlas' }] }));
    }) as typeof globalThis.fetch,
    readCsrfToken: () => 'csrf-token',
    newCorrelationId: () => 'correlation-fixed',
  });
  return { client, calls };
}

describe('File delete (FIX5 item 5)', () => {
  it('the client calls the exact routes', async () => {
    const { client, calls } = harness();
    await deleteFile(client, 'acme', 'f1');
    await restoreFile(client, 'acme', 'f1');
    expect(calls).toEqual([
      'DELETE /v1/organizations/acme/files/f1',
      'POST /v1/organizations/acme/files/f1/restore',
    ]);
  });

  it('asks, deletes, drops the row, and Undo restores it', async () => {
    const { client, calls } = harness();
    render(
      <QueryClientProvider client={new QueryClient()}>
        <FilesHubScreen organizationSlug="acme" organizationName="Acme" client={client} />
        <UndoToastHost />
      </QueryClientProvider>,
    );
    await screen.findByRole('link', { name: 'quote.csv' });
    // Only the row the API lets this person delete offers Delete.
    expect(screen.queryByRole('button', { name: 'Delete brief.csv' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Delete quote.csv' }));
    const dialog = screen.getByRole('dialog', { name: 'Delete “quote.csv”?' });
    // Cancel closes without a call.
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(calls).toEqual([]);

    fireEvent.click(screen.getByRole('button', { name: 'Delete quote.csv' }));
    fireEvent.click(
      within(screen.getByRole('dialog')).getByRole('button', { name: 'Delete file' }),
    );
    await waitFor(() => expect(calls).toEqual(['DELETE /v1/organizations/acme/files/f1']));
    await waitFor(() => expect(screen.queryByRole('link', { name: 'quote.csv' })).toBeNull());
    expect(screen.getByRole('link', { name: 'brief.csv' })).toBeTruthy();

    const toasts = screen.getByTestId('undo-toasts');
    expect(within(toasts).getByText(/File deleted/u)).toBeTruthy();
    fireEvent.click(within(toasts).getByRole('button', { name: 'Undo' }));
    await waitFor(() =>
      expect(calls).toEqual([
        'DELETE /v1/organizations/acme/files/f1',
        'POST /v1/organizations/acme/files/f1/restore',
      ]),
    );
    expect(await screen.findByRole('link', { name: 'quote.csv' })).toBeTruthy();
  });

  it('the file review page offers Delete only with canDelete, and goes back to Files after it', async () => {
    const calls: string[] = [];
    const manifest = (canDelete: boolean) => ({
      file: { id: 'f1', name: 'quote.csv', projectId: 'p1' },
      version: { fileVersionId: 'fv1', mimeType: 'text/csv', sizeBytes: 42, scanStatus: 'clean' },
      kind: 'unsupported',
      status: 'ready',
      derivatives: [],
      originalUrl: '/v1/organizations/acme/files/f1/content',
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
            versionNo: 1,
            fileAssetId: 'f1',
            fileName: 'quote.csv',
            createdAt: '2026-11-09T10:00:00.000Z',
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
        canRetry: false,
        canDelete,
      },
    });
    const viewer = (canDelete: boolean, onOpenFile?: (href: string) => void) => {
      const client = new ApiClient({
        baseUrl: 'https://api.example.test',
        csrfCookieName: 'tm_session_csrf',
        fetch: ((input: RequestInfo | URL, init?: RequestInit) => {
          const url = String(input);
          const method = init?.method ?? 'GET';
          if (method === 'DELETE') {
            calls.push(`DELETE ${url.replace('https://api.example.test', '')}`);
            return Promise.resolve(json(null, 204));
          }
          let body: unknown = {};
          if (url.includes('/preview')) body = manifest(canDelete);
          else if (url.includes('/review/threads')) body = { threads: [] };
          return Promise.resolve(json(body));
        }) as typeof globalThis.fetch,
        readCsrfToken: () => 'csrf-token',
        newCorrelationId: () => 'correlation-fixed',
      });
      return render(
        <QueryClientProvider
          client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
        >
          <FileViewer
            organizationSlug="acme"
            organizationName="Acme"
            fileId="f1"
            client={client}
            apiBase="https://api.example.test"
            {...(onOpenFile ? { onOpenFile } : {})}
          />
        </QueryClientProvider>,
      );
    };

    const readOnly = viewer(false);
    await screen.findByRole('link', { name: /Download/u });
    expect(screen.queryByRole('button', { name: 'Delete' })).toBeNull();
    readOnly.unmount();

    const opened: string[] = [];
    viewer(true, (href) => opened.push(href));
    fireEvent.click(await screen.findByRole('button', { name: 'Delete' }));
    fireEvent.click(
      within(screen.getByRole('dialog', { name: 'Delete “quote.csv”?' })).getByRole('button', {
        name: 'Delete file',
      }),
    );
    await waitFor(() => expect(opened).toEqual(['/acme/files']));
    expect(calls).toEqual(['DELETE /v1/organizations/acme/files/f1']);
  });
});
