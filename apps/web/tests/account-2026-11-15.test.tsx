import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Composer } from '../src/components/chat/pane/Composer';
import { changeMyPassword } from '../src/lib/api/auth';
import { ApiClient } from '../src/lib/api/client';
import { transcriptHoldsAttempt } from '../src/lib/sent-attempt';

/**
 * ACCOUNT lane (live persona test 2026-11-15): sharing a location keeps the text and the files
 * waiting in the composer, and a send that timed out in the browser but reached the API stops
 * saying "Not sent" once the transcript shows it.
 */

const ATTEMPT = '0198f100-0000-7000-8000-00000000ac01';

let postMessage: 'ok' | 'network' = 'ok';
const posted: unknown[] = [];

const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const url = String(input);
  if (init?.method === 'POST' && url.endsWith('/messages')) {
    posted.push(JSON.parse(String(init.body)));
    if (postMessage === 'network') return Promise.reject(new TypeError('Failed to fetch'));
    return Promise.resolve(
      new Response(JSON.stringify({ id: 'm-loc', clientGeneratedId: null }), {
        status: 201,
        headers: { 'content-type': 'application/json' },
      }),
    );
  }
  return Promise.resolve(
    new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }),
  );
});

const client = new ApiClient({
  baseUrl: 'https://api.example.test',
  csrfCookieName: 'tm_session_csrf',
  fetch: fetchMock as typeof globalThis.fetch,
  readCsrfToken: () => 'csrf-token',
  newCorrelationId: () => 'correlation-fixed',
});

function renderComposer(): { queries: QueryClient; container: HTMLElement } {
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
        extras
      />
    </QueryClientProvider>,
  );
  return { queries, container };
}

afterEach(() => {
  vi.restoreAllMocks();
  posted.length = 0;
  postMessage = 'ok';
});

describe('ACCOUNT item 1: sharing a location keeps the composer as it was', () => {
  it('posts the location and leaves the typed text and the waiting file in place', async () => {
    Object.defineProperty(navigator, 'geolocation', {
      configurable: true,
      value: {
        getCurrentPosition: (success: PositionCallback) =>
          success({ coords: { latitude: 25.2048, longitude: 55.2708 } } as GeolocationPosition),
      },
    });
    const { container } = renderComposer();
    const input = container.querySelector('input[type=file]') as HTMLInputElement;
    fireEvent.change(input, {
      target: { files: [new File([new Uint8Array(16)], 'brief.pdf', { type: 'application/pdf' })] },
    });
    const box = screen.getByRole('textbox', { name: 'Message' });
    fireEvent.change(box, { target: { value: 'Half a thought' } });

    fireEvent.click(screen.getByRole('button', { name: 'Share location' }));

    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]).toMatchObject({ kind: 'location', meta: { lat: 25.2048, lng: 55.2708 } });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(screen.getByRole('textbox', { name: 'Message' })).toHaveValue('Half a thought');
    expect(screen.getByText('brief.pdf')).toBeInTheDocument();
  });
});

describe('ACCOUNT item 2: a timed-out send that reached the API is not "Not sent"', () => {
  it('finds the attempt in either cached transcript shape', () => {
    const message = { id: 'm-1', clientGeneratedId: ATTEMPT };
    expect(transcriptHoldsAttempt([message], ATTEMPT)).toBe(true);
    expect(transcriptHoldsAttempt({ pages: [[], [message]], pageParams: [] }, ATTEMPT)).toBe(true);
    expect(
      transcriptHoldsAttempt({ pages: [[{ id: 'm-2', clientGeneratedId: null }]] }, ATTEMPT),
    ).toBe(false);
    expect(transcriptHoldsAttempt(undefined, ATTEMPT)).toBe(false);
  });

  it('clears the notice and the box once the transcript shows the stored message', async () => {
    vi.spyOn(globalThis.crypto, 'randomUUID').mockReturnValue(ATTEMPT);
    postMessage = 'network';
    const { queries } = renderComposer();
    const box = screen.getByRole('textbox', { name: 'Message' });
    fireEvent.change(box, { target: { value: 'Did this go?' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(await screen.findByText('Not sent')).toBeInTheDocument();
    expect(posted[0]).toMatchObject({ clientGeneratedId: ATTEMPT });

    act(() => {
      queries.setQueryData(['messages', 'qa', 'c-1', 'channel'], {
        pages: [[{ id: 'm-1', body: 'Did this go?', clientGeneratedId: ATTEMPT }]],
        pageParams: [undefined],
      });
    });

    await waitFor(() => expect(screen.queryByText('Not sent')).toBeNull());
    expect(screen.getByRole('textbox', { name: 'Message' })).toHaveValue('');
  });
});

describe('ACCOUNT item 4: changing my own password proves the current one first', () => {
  it('reauthenticates with the current password and code, then sends the proof with the change', async () => {
    const calls: { url: string; headers: Headers; body: unknown }[] = [];
    const api = new ApiClient({
      baseUrl: 'https://api.example.test',
      csrfCookieName: 'tm_session_csrf',
      fetch: ((input: RequestInfo | URL, init?: RequestInit) => {
        calls.push({
          url: String(input),
          headers: new Headers(init?.headers),
          body: JSON.parse(String(init?.body)),
        });
        return Promise.resolve(
          String(input).endsWith('/v1/auth/reauth')
            ? new Response(JSON.stringify({ reauthToken: 'proof-1', expiresAt: 'x' }), {
                status: 200,
                headers: { 'content-type': 'application/json' },
              })
            : new Response(null, { status: 204 }),
        );
      }) as typeof globalThis.fetch,
      readCsrfToken: () => 'csrf-token',
      newCorrelationId: () => 'correlation-fixed',
    });

    await changeMyPassword(api, {
      currentPassword: 'old-secret',
      newPassword: 'violet-harbour-lantern-41',
      code: '123456',
    });

    expect(calls.map((call) => new URL(call.url).pathname)).toEqual([
      '/v1/auth/reauth',
      '/v1/auth/password/set',
    ]);
    expect(calls[0]?.body).toEqual({ password: 'old-secret', code: '123456' });
    expect(calls[1]?.headers.get('x-reauth-token')).toBe('proof-1');
    expect(calls[1]?.body).toEqual({ password: 'violet-harbour-lantern-41' });
  });
});
