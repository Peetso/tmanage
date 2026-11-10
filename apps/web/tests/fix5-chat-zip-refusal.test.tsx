import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Composer, refusalReason } from '../src/components/chat/pane/Composer';
import { ApiClient } from '../src/lib/api/client';
import { ApiRequestError } from '../src/lib/api/errors';

/**
 * FIX5 item 3 (live check fd145807, B-N3). A message with an MP4, a CSV and a ZIP: the ZIP was
 * refused with "This file cannot be uploaded" and no name or reason, and the MP4 and CSV were left
 * on Files as orphans (duplicates on the next try). Now the refusal names the file and the reason,
 * the files already uploaded for that message are deleted again, the text stays in the box, and
 * only the refused file leaves the list.
 */

const uploaded: string[] = [];
const deleted: string[] = [];

vi.mock('../src/lib/api/uploads', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/lib/api/uploads')>();
  return {
    ...original,
    uploadProjectFile: vi.fn(
      (_client: unknown, _org: string, input: { readonly file: File }): Promise<string> => {
        // FIX5 M2: the verifier refused the ZIP for what it holds, after the upload completed.
        if (input.file.name.endsWith('-inner.zip')) {
          return Promise.reject(
            new original.UploadFailedError(
              'rejected',
              input.file.name,
              'archive_contains_blocked',
              'brief/setup.exe',
            ),
          );
        }
        if (input.file.name.endsWith('.zip')) {
          return Promise.reject(
            new ApiRequestError(422, 'validation_failed', 'This file cannot be uploaded', 'c-1', [
              { field: 'reason', message: 'archive_off' },
            ]),
          );
        }
        const id = `fa-${input.file.name}`;
        uploaded.push(id);
        return Promise.resolve(id);
      },
    ),
  };
});

vi.mock('../src/lib/api/file-delete', () => ({
  deleteFile: vi.fn((_client: unknown, _org: string, id: string) => {
    deleted.push(id);
    return Promise.resolve();
  }),
  restoreFile: vi.fn(() => Promise.resolve()),
}));

const posts: string[] = [];
const client = new ApiClient({
  baseUrl: 'https://api.example.test',
  csrfCookieName: 'tm_session_csrf',
  fetch: ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if ((init?.method ?? 'GET').toUpperCase() === 'POST' && url.endsWith('/messages')) {
      posts.push(url);
    }
    return Promise.resolve(
      new Response(JSON.stringify({}), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
  }) as typeof globalThis.fetch,
  readCsrfToken: () => 'csrf-token',
  newCorrelationId: () => 'correlation-fixed',
});

beforeEach(() => {
  uploaded.length = 0;
  deleted.length = 0;
  posts.length = 0;
});

describe('FIX5 item 3: one refused file in a multi-file message', () => {
  it('reads the reason token from a 422 file_not_allowed', () => {
    expect(
      refusalReason(
        new ApiRequestError(422, 'validation_failed', 'x', 'c', [
          { field: 'reason', message: 'too_large' },
        ]),
      ),
    ).toBe('too_large');
    expect(refusalReason(new Error('x'))).toBeNull();
    expect(
      refusalReason(new ApiRequestError(422, 'validation_failed', 'Title is required', 'c')),
    ).toBeNull();
  });

  it('names the file and the reason, removes the uploaded ones, keeps the text', async () => {
    const queries = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    const { container } = render(
      <QueryClientProvider client={queries}>
        <Composer
          api={client}
          organizationSlug="qa"
          conversationId="c-1"
          archived={false}
          label="Message"
          attachProjectId="p-1"
        />
      </QueryClientProvider>,
    );
    const input = container.querySelector('input[type=file]') as HTMLInputElement;
    const files = [
      new File(['video'], 'LIVECHECK-clip.mp4', { type: 'video/mp4' }),
      new File(['a,b'], 'LIVECHECK-quote.csv', { type: 'text/csv' }),
      new File(['PK'], 'LIVECHECK-pack.zip', { type: 'application/zip' }),
    ];
    fireEvent.change(input, { target: { files } });
    const box = screen.getByRole('textbox', { name: 'Message' });
    fireEvent.change(box, { target: { value: 'Media and data' } });
    fireEvent.keyDown(box, { key: 'Enter' });

    const alert = await screen.findByText(/LIVECHECK-pack\.zip/u, { selector: '[role=alert] *' });
    expect(alert.textContent).toMatch(/archive/u);
    expect(alert.textContent).toMatch(/Nothing was sent/u);
    await waitFor(() => expect(deleted.sort()).toEqual([...uploaded].sort()));
    expect(uploaded).toHaveLength(2);
    expect(posts).toHaveLength(0);
    expect((box as HTMLTextAreaElement).value).toBe('Media and data');
    expect(screen.queryByText('LIVECHECK-pack.zip')).toBeNull();
    expect(screen.getByText('LIVECHECK-clip.mp4')).toBeInTheDocument();
  });

  it('names the ZIP and the entry the safety check refused it for (FIX5 M2)', async () => {
    const queries = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    const { container } = render(
      <QueryClientProvider client={queries}>
        <Composer
          api={client}
          organizationSlug="qa"
          conversationId="c-1"
          archived={false}
          label="Message"
          attachProjectId="p-1"
        />
      </QueryClientProvider>,
    );
    const input = container.querySelector('input[type=file]') as HTMLInputElement;
    fireEvent.change(input, {
      target: {
        files: [
          new File(['a,b'], 'LIVECHECK-quote.csv', { type: 'text/csv' }),
          new File(['PK'], 'LIVECHECK-brief-inner.zip', { type: 'application/zip' }),
        ],
      },
    });
    const box = screen.getByRole('textbox', { name: 'Message' });
    fireEvent.change(box, { target: { value: 'The brief' } });
    fireEvent.keyDown(box, { key: 'Enter' });

    const alert = await screen.findByText(/LIVECHECK-brief-inner\.zip/u, {
      selector: '[role=alert] *',
    });
    expect(alert.textContent).toMatch(/brief\/setup\.exe/u);
    expect(alert.textContent).toMatch(/program, script or macro/u);
    expect(alert.textContent).toMatch(/Nothing was sent/u);
    await waitFor(() => expect(deleted.sort()).toEqual([...uploaded].sort()));
    expect(posts).toHaveLength(0);
    expect((box as HTMLTextAreaElement).value).toBe('The brief');
    expect(screen.queryByText('LIVECHECK-brief-inner.zip')).toBeNull();
  });
});
