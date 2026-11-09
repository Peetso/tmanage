import { describe, expect, it } from 'vitest';
import { ApiClient } from '../src/lib/api/client';
import {
  isTransientStatus,
  PART_ATTEMPTS,
  retryDelayMs,
  UploadFailedError,
  uploadProjectFile,
} from '../src/lib/api/uploads';

/**
 * FIX4 item 1 (live fe6b42bb). Part PUTs answered 503 while a fresh instance started (~20 s) and
 * files sat "being checked" forever with no scanner. Busy answers are retried with backoff on every
 * step; a file the API calls `usable` (Not scanned under the owner's policy) ends the wait.
 *
 * Copied harness from FIX3 item 1: (live check a6f66e47, F1). A chat file "Not sent — The requested resource was not
 * found": the composer linked the file to the message straight after `complete`, while the file was
 * still `uploaded` (the scan runs seconds later), and the link answered 404. The host's occasional
 * 503 on a part ended the upload outright.
 *
 * `untilReady` waits for `ready` by replaying `complete` (idempotent on a completed session); a busy
 * part is sent again; a file the scan refuses fails with a reason, before anything is posted.
 */

interface Call {
  readonly url: string;
  readonly method: string;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function harness(options: {
  readonly parts: readonly number[];
  readonly completeStatuses: readonly string[];
}) {
  const calls: Call[] = [];
  const partStatuses = [...options.parts];
  const completeStatuses = [...options.completeStatuses];
  const client = new ApiClient({
    baseUrl: 'https://app.example.test',
    csrfCookieName: 'tm_session_csrf',
    fetch: ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, method: (init?.method ?? 'GET').toUpperCase() });
      if (url.endsWith('/upload-sessions')) {
        return Promise.resolve(
          json(
            {
              id: 'us-1',
              fileAssetId: 'fa-1',
              partSizeBytes: 64,
              uploadUrls: [
                { partNumber: 1, url: 'https://app.example.test/v1/uploads/p/parts/1?t=x' },
              ],
            },
            201,
          ),
        );
      }
      if (url.endsWith('/complete')) {
        const next = completeStatuses.length > 1 ? completeStatuses.shift()! : completeStatuses[0]!;
        if (next.startsWith('http:')) {
          return Promise.resolve(
            json(
              { error: { code: 'internal', message: 'busy', correlationId: 'c' } },
              Number(next.slice(5)),
            ),
          );
        }
        const [status, usable] = next.split('+');
        return Promise.resolve(
          json({ id: 'fa-1', status, ...(usable ? { usable: true } : {}) }, 202),
        );
      }
      if (url.endsWith('/cancel')) return Promise.resolve(json({ id: 'us-1' }));
      return Promise.resolve(json({}, 404));
    }) as typeof globalThis.fetch,
    readCsrfToken: () => 'csrf-token',
    newCorrelationId: () => 'correlation-fixed',
  });
  const partFetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), method: (init?.method ?? 'GET').toUpperCase() });
    const status = partStatuses.length > 1 ? partStatuses.shift()! : partStatuses[0]!;
    return Promise.resolve(
      new Response(null, { status, headers: status === 200 ? { etag: '"e1"' } : {} }),
    );
  }) as typeof globalThis.fetch;
  return { client, calls, partFetch };
}

const csv = new File(['a,b\n1,2\n'], 'LIVECHECK-table.csv', { type: 'text/csv' });
const noWait = () => Promise.resolve();

describe('FIX4 item 1: uploads finish on a busy host and without a scanner', () => {
  it('backs off 1, 2, 4, 8, 8 s (with jitter) and treats every 5xx, 408 and 429 as busy', () => {
    expect([1, 2, 3, 4, 5].map((attempt) => retryDelayMs(attempt, () => 0))).toEqual([
      1_000, 2_000, 4_000, 8_000, 8_000,
    ]);
    expect(retryDelayMs(1, () => 1)).toBe(1_250);
    expect([500, 502, 503, 504, 408, 429].every(isTransientStatus)).toBe(true);
    expect([400, 403, 404, 413].some(isTransientStatus)).toBe(false);
  });

  it('sends a part again until the starting instance answers, then completes once', async () => {
    const waits: number[] = [];
    const { client, calls, partFetch } = harness({
      parts: [503, 503, 500, 503, 200],
      completeStatuses: ['scanning+usable'],
    });
    const id = await uploadProjectFile(
      client,
      'qa',
      { projectId: 'p1', file: csv },
      {
        fetch: partFetch,
        untilReady: true,
        sleep: (ms) => {
          waits.push(ms);
          return Promise.resolve();
        },
      },
    );
    expect(id).toBe('fa-1');
    expect(calls.filter((call) => call.method === 'PUT')).toHaveLength(5);
    expect(calls.filter((call) => call.url.endsWith('/complete'))).toHaveLength(1);
    expect(waits).toHaveLength(4);
    expect(waits[3]).toBeGreaterThanOrEqual(8_000);
  });

  it('never calls complete after a part that kept failing', async () => {
    const { client, calls, partFetch } = harness({ parts: [503], completeStatuses: ['ready'] });
    await expect(
      uploadProjectFile(
        client,
        'qa',
        { projectId: 'p1', file: csv },
        { fetch: partFetch, sleep: noWait },
      ),
    ).rejects.toBeInstanceOf(UploadFailedError);
    expect(calls.filter((call) => call.method === 'PUT')).toHaveLength(PART_ATTEMPTS);
    expect(calls.some((call) => call.url.endsWith('/complete'))).toBe(false);
  });

  it('retries a busy complete, and a usable Not scanned file ends the wait at once', async () => {
    const { client, calls, partFetch } = harness({
      parts: [200],
      completeStatuses: ['http:503', 'uploaded', 'scanning', 'scanning+usable'],
    });
    const id = await uploadProjectFile(
      client,
      'qa',
      { projectId: 'p1', file: csv },
      { fetch: partFetch, untilReady: true, sleep: noWait },
    );
    expect(id).toBe('fa-1');
    expect(calls.filter((call) => call.url.endsWith('/complete'))).toHaveLength(4);
  });
});
