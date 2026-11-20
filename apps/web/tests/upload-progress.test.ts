import { describe, expect, it } from 'vitest';
import { ApiClient } from '../src/lib/api/client';
import {
  UploadCancelledError,
  createProgressTracker,
  uploadProjectFile,
} from '../src/lib/api/uploads';
import { uploadPercent, uploadRowsReducer, type UploadRow } from '../src/lib/upload-queue';

/** Upload progress (Figma 409:6602): one figure per file, and Cancel / Retry on its row. */
describe('upload progress', () => {
  it('sums every request of a file into one figure, capped at its size', () => {
    const seen: number[] = [];
    const tracker = createProgressTracker(100, (sent) => seen.push(sent));
    const first = tracker.request();
    first(30);
    first(60);
    tracker.request()(55);
    expect(seen).toEqual([30, 60, 100]);
    expect(uploadPercent(41, 98)).toBe(41);
  });

  it('retries a stopped row from zero and ignores the old attempt', () => {
    const file = new File(['x'.repeat(10)], 'Budget 2027.xlsx');
    let rows: readonly UploadRow[] = [];
    rows = uploadRowsReducer(rows, { type: 'start', id: 'a', file });
    rows = uploadRowsReducer(rows, { type: 'progress', id: 'a', attempt: 0, sent: 6 });
    rows = uploadRowsReducer(rows, { type: 'failed', id: 'a', attempt: 0, reason: null });
    rows = uploadRowsReducer(rows, { type: 'retry', id: 'a' });
    rows = uploadRowsReducer(rows, { type: 'done', id: 'a', attempt: 0, resultId: 'late' });
    expect(rows[0]).toMatchObject({ state: 'uploading', sent: 0, attempt: 1, resultId: null });
    expect(uploadRowsReducer(rows, { type: 'remove', id: 'a' })).toEqual([]);
  });

  // QA-FIX S5/M8 (2026-11-20): a refused or blocked file keeps its row, says why and offers no Retry.
  it('keeps a refused file as a blocked row from the start, and ends a scanned-out file blocked', () => {
    const file = new File(['x'.repeat(10)], 'setup.exe');
    let rows: readonly UploadRow[] = [];
    rows = uploadRowsReducer(rows, { type: 'refused', id: 'r', file, reason: 'a program' });
    expect(rows[0]).toMatchObject({ state: 'blocked', reason: 'a program', sent: 0 });
    expect(uploadRowsReducer(rows, { type: 'retry', id: 'r' })[0]).toMatchObject({
      state: 'blocked',
    });

    rows = uploadRowsReducer(rows, { type: 'start', id: 'b', file });
    rows = uploadRowsReducer(rows, { type: 'progress', id: 'b', attempt: 0, sent: 10 });
    rows = uploadRowsReducer(rows, { type: 'blocked', id: 'b', attempt: 0, reason: 'virus' });
    expect(rows[1]).toMatchObject({ state: 'blocked', reason: 'virus' });
    rows = uploadRowsReducer(rows, { type: 'done', id: 'b', attempt: 0, resultId: 'late' });
    expect(rows[1]).toMatchObject({ state: 'blocked', resultId: null });
    expect(uploadRowsReducer(rows, { type: 'clear-settled' })).toEqual([]);
  });

  it('Cancel aborts the part, cancels the session and ends as cancelled', async () => {
    const paths: string[] = [];
    const reply = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
    const client = new ApiClient({
      baseUrl: 'https://app.example.test',
      csrfCookieName: 'c',
      fetch: ((url: string) => {
        paths.push(new URL(url).pathname);
        return Promise.resolve(
          reply({
            id: 'us-1',
            fileAssetId: 'fa',
            partSizeBytes: 9,
            uploadUrls: [{ partNumber: 1, url: 'https://p.test/1' }],
          }),
        );
      }) as typeof fetch,
      readCsrfToken: () => 'csrf',
      newCorrelationId: () => 'corr',
    });
    const cancel = new AbortController();
    const part = ((_: string, init: RequestInit) =>
      new Promise((_, reject) => {
        init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        cancel.abort();
      })) as typeof fetch;
    const file = new File(['%PDF-1.4'], 'a.pdf', { type: 'application/pdf' });
    await expect(
      uploadProjectFile(
        client,
        'o',
        { projectId: 'p', file },
        { fetch: part, signal: cancel.signal },
      ),
    ).rejects.toBeInstanceOf(UploadCancelledError);
    expect(paths.at(-1)).toBe('/v1/organizations/o/upload-sessions/us-1/cancel');
  });
});
