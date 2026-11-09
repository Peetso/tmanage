import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiClient } from '../src/lib/api/client';
import type { CoachMarksView } from '../src/lib/api/coach-marks';
import { CoachMarkTour } from '../src/components/help/CoachMarkTour';
import { activeLocale } from '../src/lib/i18n/locale-store';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  act(() => activeLocale.set('en-US'));
});

const UNSEEN: CoachMarksView = {
  tours: { my_day: null, projects: null, work_board: null },
  neverAgain: false,
};

function rect(top: number, left: number, width: number, height: number): DOMRect {
  return {
    top,
    left,
    width,
    height,
    right: left + width,
    bottom: top + height,
    x: left,
    y: top,
    toJSON: () => ({}),
  } as DOMRect;
}

const CARD = { width: 380, height: 260 };

/** Lays the page out: the step card and the My Day targets get fixed rectangles. */
function layout(targets: Record<string, DOMRect>) {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
    this: HTMLElement,
  ) {
    if (this.classList.contains('tm-coach')) return rect(0, 0, CARD.width, CARD.height);
    for (const [selector, r] of Object.entries(targets)) {
      if (this.matches(selector)) return r;
    }
    return rect(0, 0, 0, 0);
  });
}

function mount({
  dir = 'ltr',
  withTargets = true,
}: { dir?: 'ltr' | 'rtl'; withTargets?: boolean } = {}) {
  const puts: unknown[] = [];
  const client = new ApiClient({
    baseUrl: 'https://api.example.test',
    csrfCookieName: 'tm_session_csrf',
    fetch: ((_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'PUT') puts.push(JSON.parse(String(init.body)));
      return Promise.resolve(
        new Response(JSON.stringify(UNSEEN), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    }) as typeof globalThis.fetch,
    readCsrfToken: () => undefined,
    newCorrelationId: () => 'c',
  });
  const query = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <div dir={dir}>
      <button type="button">Before</button>
      {withTargets ? (
        <>
          <ul className="tm-home-cards" />
          <section aria-labelledby="tm-my-day-waiting">
            <h2 id="tm-my-day-waiting">Waiting on you</h2>
          </section>
        </>
      ) : null}
      <QueryClientProvider client={query}>
        <CoachMarkTour organizationSlug="northstar" tour="my_day" client={client} />
      </QueryClientProvider>
    </div>,
  );
  return puts;
}

describe('coach marks anchored to their target (2026-11-09)', () => {
  it('places the step next to its target with an arrow and a spotlight, never in a corner', async () => {
    // Window is 1024 x 768 in jsdom. The ranked list sits near the top: room below it.
    layout({ '.tm-home-cards': rect(100, 200, 400, 120) });
    mount();
    const dialog = await screen.findByRole('dialog', { name: 'Your day, ranked' });
    expect(dialog).toHaveAttribute('data-side', 'bottom');
    expect(dialog.style.top).toBe(`${100 + 120 + 14}px`);
    // Centred on the target: 200 + 400/2 - 380/2.
    expect(dialog.style.left).toBe(`${200 + 200 - 190}px`);
    expect(dialog.querySelector('.tm-coach__arrow')).not.toBeNull();
    const spotlight = document.querySelector<HTMLElement>('.tm-coach-spotlight');
    expect(spotlight).not.toBeNull();
    expect(spotlight!.style.top).toBe('94px');
    expect(spotlight!.style.width).toBe('412px');
    expect(document.querySelector('.tm-home-cards')!.hasAttribute('data-coach-active')).toBe(true);
    expect(dialog).toHaveAttribute('aria-modal', 'true');
  });

  it('flips above the target when there is no room below', async () => {
    layout({ '.tm-home-cards': rect(560, 200, 400, 120) });
    mount();
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveAttribute('data-side', 'top');
    expect(dialog.style.top).toBe(`${560 - 14 - 260}px`);
  });

  it('beside a tall target, sits after it in reading order: right in English, left in Arabic', async () => {
    const tall = rect(16, 40, 300, 736);
    layout({ '.tm-home-cards': tall });
    mount({ dir: 'ltr' });
    const ltr = await screen.findByRole('dialog');
    expect(ltr).toHaveAttribute('data-side', 'right');
    expect(ltr.style.left).toBe(`${40 + 300 + 14}px`);
    cleanup();

    layout({ '.tm-home-cards': rect(16, 684, 300, 736) });
    mount({ dir: 'rtl' });
    const rtl = await screen.findByRole('dialog');
    expect(rtl).toHaveAttribute('data-side', 'left');
    expect(rtl.style.left).toBe(`${684 - 14 - 380}px`);
  });

  it('moves focus into the step, keeps Tab inside it, and Escape skips the tour', async () => {
    layout({ '.tm-home-cards': rect(100, 200, 400, 120) });
    screen.queryByRole('button', { name: 'Before' })?.focus();
    const puts = mount();
    const dialog = await screen.findByRole('dialog');
    const next = screen.getByRole('button', { name: 'Next' });
    await waitFor(() => expect(document.activeElement).toBe(next));
    // Tab from the last control wraps to the first one inside the dialog.
    fireEvent.keyDown(next, { key: 'Tab' });
    expect(dialog.contains(document.activeElement)).toBe(true);
    expect(document.activeElement).toBe(screen.getByRole('checkbox'));

    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await waitFor(() => expect(puts).toEqual([{ tour: 'my_day', outcome: 'skipped' }]));
    expect(document.querySelector('[data-coach-active]')).toBeNull();
  });

  it('a step whose target is missing is a centred dialog, not a corner card', async () => {
    layout({});
    mount({ withTargets: false });
    const dialog = await screen.findByRole('dialog');
    expect(dialog.classList.contains('tm-coach--center')).toBe(true);
    expect(dialog.style.top).toBe('');
    expect(document.querySelector('.tm-coach-spotlight')).toBeNull();
  });

  it('follows the target from step to step', async () => {
    layout({
      '.tm-home-cards': rect(100, 200, 400, 120),
      'section[aria-labelledby="tm-my-day-waiting"]': rect(380, 200, 400, 60),
    });
    mount();
    await screen.findByRole('dialog', { name: 'Your day, ranked' });
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    const second = await screen.findByRole('dialog', { name: 'Waiting on you' });
    await waitFor(() => expect(second.style.top).toBe(`${380 + 60 + 14}px`));
    expect(
      document
        .querySelector('section[aria-labelledby="tm-my-day-waiting"]')!
        .hasAttribute('data-coach-active'),
    ).toBe(true);
    expect(document.querySelector('.tm-home-cards')!.hasAttribute('data-coach-active')).toBe(false);
  });
});
