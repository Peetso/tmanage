import { describe, expect, it } from 'vitest';
import { ApiClient } from '../src/lib/api/client';
import { ApiRequestError } from '../src/lib/api/errors';
import { uploadProjectFileFor } from '../src/lib/api/uploads';

/**
 * FIX6 item 1 — "Upload new version" on a deliverable. The file is handed to the version only
 * once its checks have passed (`usable`), and a refused version deletes the new file again, so a
 * failed attempt leaves no stray file in Files (live check B2).
 */
function harness() {
  const calls: string[] = [];
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const fetchImpl = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? 'GET').toUpperCase();
    calls.push(`${method} ${url.replace('https://app.example.test', '')}`);
    if (url.endsWith('/upload-sessions')) {
      return Promise.resolve(
        json(
          {
            id: 'us-1',
            fileAssetId: 'fa-1',
            partSizeBytes: 16,
            uploadUrls: [{ partNumber: 1, url: 'https://app.example.test/v1/uploads/p/parts/1' }],
          },
          201,
        ),
      );
    }
    if (url.includes('/parts/')) {
      return Promise.resolve(new Response(null, { status: 200, headers: { etag: '"e1"' } }));
    }
    if (url.endsWith('/complete')) {
      // The first answer is still checking; the replay says the checks passed.
      const replays = calls.filter((c) => c.endsWith('/complete')).length;
      return Promise.resolve(
        json(
          replays === 1
            ? { id: 'fa-1', status: 'verifying' }
            : { id: 'fa-1', status: 'scanning', usable: true },
          202,
        ),
      );
    }
    if (method === 'DELETE') return Promise.resolve(new Response(null, { status: 204 }));
    return Promise.resolve(json({}, 404));
  }) as typeof globalThis.fetch;
  const client = new ApiClient({
    baseUrl: 'https://app.example.test',
    csrfCookieName: 'tm_session_csrf',
    fetch: fetchImpl,
    readCsrfToken: () => 'csrf-token',
    newCorrelationId: () => 'correlation-fixed',
  });
  return { client, calls, fetchImpl };
}

const file = new File(['0123456789'], 'brief.pdf', { type: 'application/pdf' });
const deps = (fetchImpl: typeof globalThis.fetch) => ({
  fetch: fetchImpl,
  newKey: () => 'key-0123456789abcdef',
  sleep: () => Promise.resolve(),
});

describe('uploadProjectFileFor', () => {
  it('hands the file over only once its checks passed', async () => {
    const t = harness();
    const used: string[] = [];
    await uploadProjectFileFor(
      t.client,
      'acme',
      { projectId: 'p-1', file },
      (id) => {
        used.push(`${id} after ${t.calls.filter((c) => c.endsWith('/complete')).length} checks`);
        return Promise.resolve();
      },
      deps(t.fetchImpl),
    );
    expect(used).toEqual(['fa-1 after 2 checks']);
    expect(t.calls.some((c) => c.startsWith('DELETE'))).toBe(false);
  });

  it('deletes the new file when the version is refused, and reports the refusal', async () => {
    const t = harness();
    const refusal = new ApiRequestError(
      422,
      'validation_failed',
      'That file cannot be attached',
      'correlation-fixed',
    );
    await expect(
      uploadProjectFileFor(
        t.client,
        'acme',
        { projectId: 'p-1', file },
        () => Promise.reject(refusal),
        deps(t.fetchImpl),
      ),
    ).rejects.toBe(refusal);
    expect(t.calls).toContain('DELETE /v1/organizations/acme/files/fa-1');
  });
});
