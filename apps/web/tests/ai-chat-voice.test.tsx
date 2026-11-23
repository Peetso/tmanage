import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiClient } from '../src/lib/api/client';
import { AiChatPanel } from '../src/components/ai-chat/AiChatPanel';
import type { RecognitionResultEventLike, SpeechRecognitionLike } from '../src/lib/voice/speech';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn(), refresh: vi.fn() }),
  usePathname: () => '/',
  useSearchParams: () => new URLSearchParams(),
  useParams: () => ({}),
}));

/**
 * Plan 62-16 — TManage AI voice mode (Figma G3 766:43968, 789:50684). The browser's speech
 * engines are faked; what is proved is that voice only fills the box and never sends by itself.
 */

const BASE = 'https://api.example.test/v1/organizations/northstar';

class FakeRecognition implements SpeechRecognitionLike {
  static last: FakeRecognition | null = null;
  lang = '';
  continuous = false;
  interimResults = false;
  onresult: SpeechRecognitionLike['onresult'] = null;
  onerror: SpeechRecognitionLike['onerror'] = null;
  onend: SpeechRecognitionLike['onend'] = null;
  start = vi.fn();
  stop = vi.fn();
  abort = vi.fn();
  constructor() {
    FakeRecognition.last = this;
  }
}

function heard(words: string, isFinal: boolean): RecognitionResultEventLike {
  const list = [{ isFinal, length: 1, 0: { transcript: words } }];
  return { results: Object.assign(list, { length: 1 }) };
}

function mount() {
  const posts: string[] = [];
  const api = new ApiClient({
    baseUrl: 'https://api.example.test',
    csrfCookieName: 'tm_session_csrf',
    fetch: ((input: RequestInfo | URL, init?: RequestInit) => {
      if ((init?.method ?? 'GET') !== 'GET') posts.push(String(input));
      const chat = String(input) === `${BASE}/copilot/chat`;
      const body = chat
        ? {
            state: 'answer',
            answer: 'Mona Samir has two: Homepage hero copy and Contact form copy.',
            navigation: null,
            domain: 'tasks',
            tier: 'low',
            ceilingCredits: null,
            stop: null,
            suggestedTier: null,
            truncated: false,
            withheldFigures: 0,
            toolCalls: [],
            chargedCredits: 1,
            card: null,
            undo: null,
            conversationId: '0b6f2a8e-0000-4000-8000-000000000001',
            retryAfterSeconds: null,
            file: null,
          }
        : { code: 'not_found' };
      return Promise.resolve(
        new Response(JSON.stringify(body), {
          status: chat ? 200 : 404,
          headers: { 'content-type': 'application/json' },
        }),
      );
    }) as typeof globalThis.fetch,
    readCsrfToken: () => undefined,
    newCorrelationId: () => 'c',
  });
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <AiChatPanel organizationSlug="northstar" client={api} onClose={() => {}} />
    </QueryClientProvider>,
  );
  return {
    posts,
    box: () => screen.getByLabelText('Message to TManage AI') as HTMLTextAreaElement,
  };
}

afterEach(() => {
  delete (window as { webkitSpeechRecognition?: unknown }).webkitSpeechRecognition;
  FakeRecognition.last = null;
  vi.unstubAllGlobals();
});

describe('TManage AI voice mode (62-16)', () => {
  it('says so where the browser has no voice, and draws no microphone', () => {
    mount();
    expect(
      screen.getByText('Voice isn’t available in this browser. Type your question instead.'),
    ).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Talk instead of typing' })).toBeNull();
  });

  it('fills the box while listening and sends only when the member presses Send', async () => {
    (window as { webkitSpeechRecognition?: unknown }).webkitSpeechRecognition = FakeRecognition;
    const { posts, box } = mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Talk instead of typing' }));
    expect(screen.getByText('Listening… tap the microphone again when you finish.')).toBeTruthy();

    act(() => FakeRecognition.last!.onresult?.(heard('yes confirm the change', false)));
    expect(box().value).toBe('yes confirm the change');
    expect(screen.getByRole('button', { name: 'Send' }).hasAttribute('disabled')).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: 'Stop listening' }));
    act(() => {
      FakeRecognition.last!.onresult?.(heard('Who has the most of them?', true));
      FakeRecognition.last!.onend?.();
    });
    expect(box().value).toBe('Who has the most of them?');
    expect(screen.getByText('Check the words, then send. You can edit them first.')).toBeTruthy();
    expect(posts).toHaveLength(0);

    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(await screen.findByText(/Mona Samir has two/)).toBeTruthy();
    expect(posts).toEqual([`${BASE}/copilot/chat`]);
  });

  it('Cancel stops listening and puts the typed words back', async () => {
    (window as { webkitSpeechRecognition?: unknown }).webkitSpeechRecognition = FakeRecognition;
    const { box } = mount();
    fireEvent.change(box(), { target: { value: 'Draft' } });
    fireEvent.click(await screen.findByRole('button', { name: 'Talk instead of typing' }));
    act(() => FakeRecognition.last!.onresult?.(heard('and more words', false)));
    expect(box().value).toBe('Draft and more words');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(box().value).toBe('Draft');
    expect(FakeRecognition.last!.abort).toHaveBeenCalled();
  });

  it('reads an answer aloud and stops from the bar (766:43968, 789:50684)', async () => {
    const speak = vi.fn();
    const cancel = vi.fn();
    vi.stubGlobal('speechSynthesis', { speak, cancel });
    vi.stubGlobal(
      'SpeechSynthesisUtterance',
      class {
        lang = '';
        onend: (() => void) | null = null;
        onerror: (() => void) | null = null;
        constructor(public text: string) {}
      },
    );
    const { box } = mount();
    fireEvent.change(box(), { target: { value: 'Who has the most of them?' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Read this answer aloud' }));
    expect(speak).toHaveBeenCalledTimes(1);
    expect((speak.mock.calls[0]![0] as { text: string }).text).toBe(
      'Mona Samir has two: Homepage hero copy and Contact form copy.',
    );
    expect(screen.getByText('Reading the answer aloud')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    expect(screen.queryByText('Reading the answer aloud')).toBeNull();
    expect(cancel).toHaveBeenCalled();
  });

  it('dictates in the language picked in the composer chip, saved for next time (878:976)', async () => {
    (window as { webkitSpeechRecognition?: unknown }).webkitSpeechRecognition = FakeRecognition;
    window.localStorage.removeItem('tm.voice.dictationLanguage.northstar');
    mount();
    fireEvent.click(
      await screen.findByRole('button', { name: 'Dictation language: English (US)' }),
    );
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search languages' }), {
      target: { value: 'egypt' },
    });
    fireEvent.click(screen.getByRole('radio', { name: /Arabic \(Egypt\)/ }), { detail: 1 });
    expect(window.localStorage.getItem('tm.voice.dictationLanguage.northstar')).toBe('ar-EG');
    fireEvent.click(screen.getByRole('button', { name: 'Talk instead of typing' }));
    expect(FakeRecognition.last!.lang).toBe('ar-EG');
    window.localStorage.removeItem('tm.voice.dictationLanguage.northstar');
  });

  it('in the desktop app the chip is disabled with why, and no microphone is drawn', async () => {
    (window as { webkitSpeechRecognition?: unknown }).webkitSpeechRecognition = FakeRecognition;
    (window as { tmanageDesktop?: unknown }).tmanageDesktop = {};
    try {
      mount();
      const chip = await screen.findByRole('button', { name: /Dictation language/ });
      await waitFor(() => expect(chip.getAttribute('aria-disabled')).toBe('true'));
      expect(screen.queryByRole('button', { name: 'Talk instead of typing' })).toBeNull();
      expect(
        screen.getByText('Voice isn’t in the desktop app yet. Type your question instead.'),
      ).toBeTruthy();
    } finally {
      delete (window as { tmanageDesktop?: unknown }).tmanageDesktop;
    }
  });
});
