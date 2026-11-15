import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { Composer } from '../src/components/chat/pane/Composer';
import { longDay, shortDay } from '../src/components/screens/PortalParts';
import { fitZoom } from '../src/components/viewer/viewer-geometry';
import { ApiClient } from '../src/lib/api/client';
import type * as AttachmentsModule from '../src/lib/api/message-attachments';
import type * as UploadsModule from '../src/lib/api/uploads';

/**
 * SMALLFIX (live feedback 2026-11-15): chat upload progress, a "Not sent" notice on a message that
 * was sent, a Word page wider than the pane, a small image opened at 151 %, and portal dates
 * hand-built in English.
 */

let mode: 'hang' | 'done' = 'hang';

vi.mock('../src/lib/api/uploads', async (importOriginal) => {
  const original = await importOriginal<typeof UploadsModule>();
  return {
    ...original,
    uploadProjectFile: vi.fn(
      (
        _client: unknown,
        _org: string,
        input: { readonly file: File },
        deps: UploadsModule.UploadAttachmentOptions,
      ): Promise<string> => {
        deps.onProgress?.(input.file.size / 2);
        return mode === 'hang' ? new Promise<string>(() => undefined) : Promise.resolve('fa-1');
      },
    ),
  };
});

vi.mock('../src/lib/api/message-attachments', async (importOriginal) => ({
  ...(await importOriginal<typeof AttachmentsModule>()),
  attachMessageFile: vi.fn(() => Promise.reject(new Error('link failed'))),
}));

const client = new ApiClient({
  baseUrl: 'https://api.example.test',
  csrfCookieName: 'tm_session_csrf',
  fetch: (() =>
    Promise.resolve(
      new Response(JSON.stringify({ id: 'm-1' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    )) as typeof globalThis.fetch,
  readCsrfToken: () => 'csrf-token',
  newCorrelationId: () => 'correlation-fixed',
});

function sendOneFile(): void {
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
    target: { files: [new File([new Uint8Array(4096)], 'brief.pdf', { type: 'application/pdf' })] },
  });
  const box = screen.getByRole('textbox', { name: 'Message' });
  fireEvent.change(box, { target: { value: 'The brief' } });
  fireEvent.keyDown(box, { key: 'Enter' });
}

describe('SMALLFIX item 1: chat attachment upload progress', () => {
  it('shows the file’s progress bar and bytes while it uploads', async () => {
    mode = 'hang';
    sendOneFile();
    const bar = await screen.findByRole('progressbar');
    expect(bar.getAttribute('aria-valuenow')).toBe('50');
  });
});

describe('SMALLFIX item 2: a sent message is never "Not sent"', () => {
  it('says the message was sent when only linking the file failed', async () => {
    mode = 'done';
    sendOneFile();
    expect(await screen.findByText('Message sent without a file')).toBeInTheDocument();
    expect(screen.queryByText('Not sent')).toBeNull();
  });
});

describe('SMALLFIX items 3 and 4: fit never enlarges past 100 %', () => {
  it('shows a small image at 100 % instead of 151 %', () => {
    expect(fitZoom({ width: 600, height: 400 }, { width: 906, height: 700 }, 'contain', 1)).toBe(1);
    expect(fitZoom({ width: 600, height: 400 }, { width: 906, height: 700 }, 'contain')).toBe(1.51);
  });

  it('shrinks a Word page to the pane width', () => {
    expect(fitZoom({ width: 794, height: 1 }, { width: 600, height: 1 }, 'width', 1)).toBeCloseTo(
      0.7557,
      3,
    );
  });
});

describe('SMALLFIX item 5: portal dates through the shared formatter', () => {
  it('writes a full day in English and Arabic', () => {
    expect(shortDay('2026-11-30', 'en')).toBe('30 Nov');
    expect(longDay('2026-11-30', 'en')).toBe('30 November');
    const arabic = shortDay('2026-11-30', 'ar');
    expect(arabic).toMatch(/30/u);
    expect(arabic).toMatch(/نوفمبر/u);
  });
});
