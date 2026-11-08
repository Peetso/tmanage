import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { ApiClient } from '../src/lib/api/client';
import { shouldShowTour } from '../src/lib/api/coach-marks';
import type { CoachMarksView } from '../src/lib/api/coach-marks';
import { CoachMarkTour } from '../src/components/help/CoachMarkTour';
import { TeachingEmptyState } from '../src/components/help/TeachingEmptyState';
import { activeLocale } from '../src/lib/i18n/locale-store';

afterEach(() => {
  cleanup();
  act(() => activeLocale.set('en-US'));
});

const UNSEEN: CoachMarksView = {
  tours: { my_day: null, projects: null, work_board: null },
  neverAgain: false,
};

function mount(view: CoachMarksView) {
  const puts: unknown[] = [];
  const client = new ApiClient({
    baseUrl: 'https://api.example.test',
    csrfCookieName: 'tm_session_csrf',
    fetch: ((_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'PUT') puts.push(JSON.parse(String(init.body)));
      return Promise.resolve(
        new Response(JSON.stringify(view), {
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
    <QueryClientProvider client={query}>
      <CoachMarkTour organizationSlug="northstar" tour="my_day" client={client} />
    </QueryClientProvider>,
  );
  return puts;
}

describe('first-visit tours (55-09)', () => {
  it('opens only for an unseen tour while tours are on', () => {
    expect(shouldShowTour(UNSEEN, 'my_day')).toBe(true);
    expect(shouldShowTour({ ...UNSEEN, neverAgain: true }, 'my_day')).toBe(false);
    expect(
      shouldShowTour({ ...UNSEEN, tours: { ...UNSEEN.tours, my_day: 'skipped' } }, 'my_day'),
    ).toBe(false);
    expect(shouldShowTour(undefined, 'my_day')).toBe(false);
    expect(shouldShowTour({ projects: [] } as unknown as CoachMarksView, 'my_day')).toBe(false);
  });

  it('walks three steps and records done', async () => {
    const puts = mount(UNSEEN);
    expect(await screen.findByText('1 of 3')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    await waitFor(() => expect(puts).toEqual([{ tour: 'my_day', outcome: 'done' }]));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('skip with "never again" stores both', async () => {
    const puts = mount(UNSEEN);
    fireEvent.click(await screen.findByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: 'Skip tour' }));
    await waitFor(() =>
      expect(puts).toEqual([{ tour: 'my_day', outcome: 'skipped', neverAgain: true }]),
    );
  });

  it('stays closed when tours are turned off', async () => {
    mount({ ...UNSEEN, neverAgain: true });
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

describe('empty states that teach (55-10)', () => {
  it('shows one line, one action and a help link in the reader language', () => {
    act(() => activeLocale.set('ar-EG'));
    render(
      <TeachingEmptyState
        title="No projects yet"
        explanation="Projects hold your work."
        action={<button type="button">New project</button>}
        helpSlug="start-a-project"
        helpLabel="How projects work"
      />,
    );
    expect(screen.getByText('Projects hold your work.')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'How projects work' }).getAttribute('href')).toBe(
      '/ar/help/start-a-project',
    );
  });

  it('drops the help link when the article does not exist', () => {
    render(<TeachingEmptyState title="x" explanation="y" helpSlug="nope" helpLabel="Help" />);
    expect(screen.queryByRole('link')).toBeNull();
  });
});
