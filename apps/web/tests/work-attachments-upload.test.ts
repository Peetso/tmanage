import { describe, expect, it } from 'vitest';
import { ApiClient, NetworkError } from '../src/lib/api/client';
import {
  MAX_ATTACHMENT_BYTES,
  attachmentMimeType,
  attachmentProblem,
  uploadProjectFile,
  uploadsGoToDrive,
} from '../src/lib/api/uploads';
import type { StorageStatusView } from '../src/lib/api/google-drive';

/**
 * The New work capsule's attachments ride the existing upload pipeline (FILE-001/002). The API and
 * the verifier decide what is admitted — proved in `apps/api` and `e2e/tests/upload-journeys.spec.ts`.
 * This file proves the browser half: the early refusals say why in words, and an upload is the
 * three-step protocol the journey drives — a session opened with an `Idempotency-Key`, every part
 * PUT without the session cookie, completion on the etags — with the session cancelled if a part
 * fails.
 */

interface Call {
  readonly url: string;
  readonly method: string;
  readonly headers: Headers;
  readonly body: unknown;
  readonly credentials: RequestCredentials | undefined;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function harness(partHandler: (url: string) => Response) {
  const calls: Call[] = [];
  const record = (input: RequestInfo | URL, init?: RequestInit): Call => {
    const call: Call = {
      url: String(input),
      method: (init?.method ?? 'GET').toUpperCase(),
      headers: new Headers(init?.headers),
      body:
        typeof init?.body === 'string'
          ? (JSON.parse(init.body) as unknown)
          : (init?.body ?? undefined),
      credentials: init?.credentials,
    };
    calls.push(call);
    return call;
  };
  const client = new ApiClient({
    baseUrl: 'https://app.example.test',
    csrfCookieName: 'tm_session_csrf',
    fetch: ((input: RequestInfo | URL, init?: RequestInit) => {
      const call = record(input, init);
      if (call.url.endsWith('/upload-sessions')) {
        return Promise.resolve(
          json(
            {
              id: 'us-1',
              fileAssetId: 'fa-1',
              partSizeBytes: 4,
              uploadUrls: [
                { partNumber: 2, url: 'https://app.example.test/v1/uploads/p/parts/2?t=x' },
                { partNumber: 1, url: 'https://app.example.test/v1/uploads/p/parts/1?t=x' },
                { partNumber: 3, url: 'https://app.example.test/v1/uploads/p/parts/3?t=x' },
              ],
            },
            201,
          ),
        );
      }
      if (call.url.endsWith('/complete'))
        return Promise.resolve(json({ id: 'fa-1', status: 'uploaded' }, 202));
      if (call.url.endsWith('/cancel'))
        return Promise.resolve(json({ id: 'us-1', status: 'cancelled' }));
      return Promise.resolve(json({}, 404));
    }) as typeof globalThis.fetch,
    readCsrfToken: () => 'csrf-token',
    newCorrelationId: () => 'correlation-fixed',
  });
  const partFetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    record(input, init);
    return Promise.resolve(partHandler(String(input)));
  }) as typeof globalThis.fetch;
  return { client, calls, partFetch };
}

const tenBytes = new File(['0123456789'], 'brief.pdf', { type: 'application/pdf' });

describe('attachment checks', () => {
  it('declares the browser type when admitted and falls back to the extension', () => {
    expect(attachmentMimeType({ name: 'a.pdf', size: 1, type: 'application/pdf' })).toBe(
      'application/pdf',
    );
    expect(attachmentMimeType({ name: 'notes.md', size: 1, type: '' })).toBe('text/markdown');
    expect(attachmentMimeType({ name: 'Photo.JPG', size: 1, type: '' })).toBe('image/jpeg');
    expect(
      attachmentMimeType({ name: 'setup.exe', size: 1, type: 'application/x-msdownload' }),
    ).toBeNull();
    expect(attachmentMimeType({ name: 'noextension', size: 1, type: '' })).toBeNull();
  });

  it('declares the R4 proofing formats the verifier admits', () => {
    const cases: readonly (readonly [string, string, string])[] = [
      ['design.psd', 'image/vnd.adobe.photoshop', 'image/vnd.adobe.photoshop'],
      ['logo.svg', 'image/svg+xml', 'image/svg+xml'],
      ['IMG_0001.HEIC', '', 'image/heic'],
      ['scan.tif', '', 'image/tiff'],
      ['mark.eps', 'application/postscript', 'application/postscript'],
      ['cut.mov', 'video/quicktime', 'video/quicktime'],
      ['reel.mp4', 'video/mp4', 'video/mp4'],
      ['voice.m4a', 'audio/x-m4a', 'audio/mp4'],
      ['take.wav', 'audio/x-wav', 'audio/wav'],
      ['song.mp3', 'audio/mpeg', 'audio/mpeg'],
      ['loop.ogg', 'video/ogg', 'audio/ogg'],
      ['master.flac', '', 'audio/flac'],
    ];
    for (const [name, type, declared] of cases) {
      expect(attachmentMimeType({ name, size: 1, type }), name).toBe(declared);
    }
  });

  it('declares an Illustrator file by its extension, whatever the browser reports', () => {
    // Reversal: let the reported type win and `.ai` is declared PostScript, then refused by
    // the verifier because its bytes are a PDF.
    expect(attachmentMimeType({ name: 'logo.ai', size: 1, type: 'application/postscript' })).toBe(
      'application/illustrator',
    );
    expect(attachmentMimeType({ name: 'logo.AI', size: 1, type: '' })).toBe(
      'application/illustrator',
    );
  });

  it('names the reason a file is refused before any byte moves', () => {
    expect(attachmentProblem({ name: 'ok.png', size: 10, type: 'image/png' })).toBeNull();
    expect(attachmentProblem({ name: 'empty.txt', size: 0, type: 'text/plain' })).toMatch(/empty/);
    expect(
      attachmentProblem({
        name: 'huge.zip',
        size: MAX_ATTACHMENT_BYTES + 1,
        type: 'application/zip',
      }),
    ).toMatch(/larger than 100 MB/);
    expect(
      attachmentProblem({ name: 'run.exe', size: 10, type: 'application/x-msdownload' }),
    ).toMatch(/not a file type TManage accepts/);
  });
});

describe('uploadProjectFile', () => {
  it('opens a session, PUTs each part in order without the cookie, and completes on the etags', async () => {
    const { client, calls, partFetch } = harness((url) => {
      const n = /parts\/(\d+)/.exec(url)?.[1];
      return new Response(null, { status: 200, headers: { etag: `"etag-${n}"` } });
    });

    const id = await uploadProjectFile(
      client,
      'northstar',
      { projectId: 'proj-1', file: tenBytes },
      { fetch: partFetch, newKey: () => 'key-0123456789abcdef' },
    );
    expect(id).toBe('fa-1');

    const create = calls[0];
    expect(create?.method).toBe('POST');
    expect(create?.url).toBe('https://app.example.test/v1/organizations/northstar/upload-sessions');
    expect(create?.headers.get('idempotency-key')).toBe('key-0123456789abcdef');
    expect(create?.headers.get('x-csrf-token')).toBe('csrf-token');
    expect(create?.body).toEqual({
      projectId: 'proj-1',
      fileName: 'brief.pdf',
      mimeType: 'application/pdf',
      sizeBytes: 10,
      purpose: 'deliverable',
    });

    const puts = calls.filter((call) => call.method === 'PUT');
    expect(puts.map((call) => /parts\/(\d+)/.exec(call.url)?.[1])).toEqual(['1', '2', '3']);
    for (const put of puts) {
      expect(put.credentials).toBe('omit');
      expect(put.headers.get('x-csrf-token')).toBeNull();
      expect(put.headers.get('content-type')).toBe('application/octet-stream');
    }
    const sizes = await Promise.all(puts.map((put) => (put.body as Blob).size));
    expect(sizes).toEqual([4, 4, 2]);

    const complete = calls.at(-1);
    expect(complete?.url).toBe(
      'https://app.example.test/v1/organizations/northstar/upload-sessions/us-1/complete',
    );
    expect(complete?.body).toEqual({
      parts: [
        { partNumber: 1, etag: '"etag-1"' },
        { partNumber: 2, etag: '"etag-2"' },
        { partNumber: 3, etag: '"etag-3"' },
      ],
    });
  });

  it('cancels the session when a part is refused, and does not complete', async () => {
    const { client, calls, partFetch } = harness(() => new Response('no', { status: 413 }));

    await expect(
      uploadProjectFile(
        client,
        'northstar',
        { projectId: 'proj-1', file: tenBytes },
        { fetch: partFetch },
      ),
    ).rejects.toThrow(/could not be uploaded/);

    expect(calls.some((call) => call.url.endsWith('/complete'))).toBe(false);
    expect(calls.at(-1)?.url).toBe(
      'https://app.example.test/v1/organizations/northstar/upload-sessions/us-1/cancel',
    );
  });

  it('refuses a file type the verifier does not admit without opening a session', async () => {
    const { client, calls, partFetch } = harness(() => new Response(null, { status: 200 }));
    const exe = new File(['x'], 'setup.exe', { type: 'application/x-msdownload' });
    await expect(
      uploadProjectFile(
        client,
        'northstar',
        { projectId: 'proj-1', file: exe },
        { fetch: partFetch },
      ),
    ).rejects.toThrow(/not a file type/);
    expect(calls).toHaveLength(0);
  });
});

describe('upload deadlines and storage (wave 17)', () => {
  it('ends a stalled part PUT as a NetworkError and cancels the session', async () => {
    const { client, calls } = harness(() => new Response(null));
    const stalled = ((_url: unknown, init?: RequestInit) =>
      new Promise((_ok, fail) => init?.signal?.addEventListener('abort', fail))) as typeof fetch;
    const deadline = (ms: number) => AbortSignal.timeout(ms > 60_000 ? 1 : ms);
    const input = { projectId: 'p', file: tenBytes };
    const upload = uploadProjectFile(client, 'org', input, { fetch: stalled, deadline });
    await expect(upload).rejects.toBeInstanceOf(NetworkError);
    expect(calls.at(-1)?.url).toMatch(/us-1\/cancel$/);
  });
  it('sends files to Google Drive only when Drive is the connected company storage', () => {
    const at = (storageMode: string, status: string) =>
      uploadsGoToDrive({ storageMode, googleDrive: { status } } as StorageStatusView);
    expect([at('google_drive', 'connected'), at('google_drive', 'error')]).toEqual([true, false]);
    expect([at('tmanage', 'connected'), uploadsGoToDrive(undefined)]).toEqual([false, false]);
  });
});
