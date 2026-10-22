import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { ChangelogScreen } from '../src/components/screens/ChangelogScreen';
import { ApiClient } from '../src/lib/api/client';
import type { PublicChangelogView } from '../src/lib/api/public-changelog';
import { activeLocale } from '../src/lib/i18n/locale-store';

/**
 * **L9 — the changelog's screen-reader status (live report line 47).** On `/changelog` the shell's
 * visually-hidden live region kept "Loading the changelog." — in English — after the empty state
 * had loaded in Arabic. The loading sentence must leave with the loading state, and the region must
 * end on the loaded state in the active language.
 */
const EMPTY: PublicChangelogView = { months: [] };

/** A client whose single answer is released by the test, so the locale can change mid-load. */
function deferredClient(view: PublicChangelogView) {
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const client = new ApiClient({
    baseUrl: 'https://api.example.test',
    csrfCookieName: 'tm_session_csrf',
    fetch: (async () => {
      await gate;
      return new Response(JSON.stringify(view), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof globalThis.fetch,
    readCsrfToken: () => undefined,
    newCorrelationId: () => 'correlation-fixed',
  });
  return { client, release: () => release() };
}

function withQuery(children: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

function liveText(container: HTMLElement): string[] {
  return [...container.querySelectorAll('[aria-live]')]
    .map((node) => node.textContent ?? '')
    .filter(Boolean);
}

describe('ChangelogScreen live region (L9)', () => {
  afterEach(() => activeLocale.set('en-US'));

  it('clears the loading sentence and announces the empty state once loaded', async () => {
    const { client, release } = deferredClient(EMPTY);
    const { container } = render(withQuery(<ChangelogScreen client={client} />));
    expect(liveText(container)).toEqual(['Loading the changelog.']);

    await act(async () => release());

    await waitFor(() => expect(screen.getAllByText('Nothing here yet').length).toBeGreaterThan(0));
    expect(liveText(container)).toEqual(['Nothing here yet']);
  });

  it('ends in Arabic when the locale changed while loading', async () => {
    const { client, release } = deferredClient(EMPTY);
    const { container } = render(withQuery(<ChangelogScreen client={client} />));
    expect(liveText(container)).toEqual(['Loading the changelog.']);

    act(() => activeLocale.set('ar-EG'));
    expect(liveText(container)).toEqual(['جارٍ تحميل سجل التغييرات.']);

    await act(async () => release());

    await waitFor(() => expect(liveText(container)).toEqual(['لا شيء هنا بعد']));
    expect(container.textContent).not.toContain('Loading the changelog.');
  });

  it('does not leave the loading sentence behind when updates loaded', async () => {
    const { client, release } = deferredClient({
      months: [
        {
          month: '2026-10',
          entries: [
            {
              id: 'e1',
              version: '1.4.0',
              title: 'Faster boards',
              bodyMd: 'Boards load faster.',
              category: 'feature',
              publishedAt: '2026-10-20T09:00:00.000Z',
            },
          ],
        },
      ],
    });
    const { container } = render(withQuery(<ChangelogScreen client={client} />));

    await act(async () => release());

    await waitFor(() => expect(screen.getByText('Faster boards')).toBeDefined());
    expect(liveText(container)).not.toContain('Loading the changelog.');
  });
});
