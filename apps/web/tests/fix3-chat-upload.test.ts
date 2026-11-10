import { describe, expect, it } from 'vitest';
import { ApiClient } from '../src/lib/api/client';
import { UploadFailedError, uploadProjectFile } from '../src/lib/api/uploads';

/**
 * FIX3 item 1 (live check a6f66e47, F1). A chat file "Not sent — The requested resource was not
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
        const status = completeStatuses.length > 1 ? completeStatuses.shift() : completeStatuses[0];
        // FIX5 M2: a member's answer names why a file was refused (and, for a ZIP, the entry).
        const why =
          status === 'rejected'
            ? { rejectionCode: 'archive_nested', rejectedEntry: 'more/inner.zip' }
            : {};
        return Promise.resolve(json({ id: 'fa-1', status, ...why }, 202));
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

describe('FIX3 item 1: a chat file is ready before the message names it', () => {
  it('waits for the scan to make the file ready', async () => {
    const { client, calls, partFetch } = harness({
      parts: [200],
      completeStatuses: ['uploaded', 'verifying', 'scanning', 'ready'],
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

  it('answers at once without untilReady (a work item takes a file still checking)', async () => {
    const { client, calls, partFetch } = harness({ parts: [200], completeStatuses: ['uploaded'] });
    await uploadProjectFile(client, 'qa', { projectId: 'p1', file: csv }, { fetch: partFetch });
    expect(calls.filter((call) => call.url.endsWith('/complete'))).toHaveLength(1);
  });

  it('sends a part again when the host answers 503', async () => {
    const { client, calls, partFetch } = harness({
      parts: [503, 503, 200],
      completeStatuses: ['ready'],
    });
    await uploadProjectFile(
      client,
      'qa',
      { projectId: 'p1', file: csv },
      { fetch: partFetch, untilReady: true, sleep: noWait },
    );
    expect(calls.filter((call) => call.method === 'PUT')).toHaveLength(3);
  });

  it('stops after a part that stays busy: no complete, the session is cancelled', async () => {
    const { client, calls, partFetch } = harness({ parts: [503], completeStatuses: ['ready'] });
    const failure = uploadProjectFile(
      client,
      'qa',
      { projectId: 'p1', file: csv },
      { fetch: partFetch, untilReady: true, sleep: noWait },
    );
    await expect(failure).rejects.toBeInstanceOf(UploadFailedError);
    await expect(failure).rejects.toMatchObject({ reason: 'busy' });
    expect(calls.some((call) => call.url.endsWith('/complete'))).toBe(false);
    expect(calls.at(-1)?.url).toMatch(/\/cancel$/);
  });

  it('fails with a reason when the scan refuses the file', async () => {
    const { client, partFetch } = harness({
      parts: [200],
      completeStatuses: ['scanning', 'rejected'],
    });
    await expect(
      uploadProjectFile(
        client,
        'qa',
        { projectId: 'p1', file: csv },
        { fetch: partFetch, untilReady: true, sleep: noWait },
      ),
    ).rejects.toMatchObject({ reason: 'rejected' });
  });

  it('carries the reason token and the refused ZIP entry from the answer (FIX5 M2)', async () => {
    const { client, partFetch } = harness({
      parts: [200],
      completeStatuses: ['scanning', 'rejected'],
    });
    await expect(
      uploadProjectFile(
        client,
        'qa',
        { projectId: 'p1', file: csv },
        { fetch: partFetch, untilReady: true, sleep: noWait },
      ),
    ).rejects.toMatchObject({
      reason: 'rejected',
      rejectionCode: 'archive_nested',
      rejectedEntry: 'more/inner.zip',
    });
  });
});
