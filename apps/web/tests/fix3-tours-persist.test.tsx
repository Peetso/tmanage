import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { ApiClient } from '../src/lib/api/client';
import type { CoachMarksView } from '../src/lib/api/coach-marks';
import { CoachMarkTour } from '../src/components/help/CoachMarkTour';

/**
 * FIX3 item 4 (live check a6f66e47 T1, T2): a tour finished with Done or Skip never opens again,
 * even when the server's answer is old or the save did not land; the Board tour's first two steps
 * sit next to the board, including when the board is drawn after the tour opened.
 */

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  document.body.innerHTML = '';
});

const UNSEEN: CoachMarksView = {
  tours: { my_day: null, projects: null, work_board: null },
  neverAgain: false,
};

/** A server that never remembers: every read and every save answers "not seen". */
function forgetfulServer() {
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
  return { client, puts };
}

function mount(client: ApiClient, tour: 'my_day' | 'work_board' = 'my_day') {
  const query = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={query}>
      <CoachMarkTour organizationSlug="northstar" tour={tour} client={client} />
    </QueryClientProvider>,
  );
}

describe('tours stay finished (FIX3 item 4)', () => {
  it('does not open again after Skip, on a new visit, and sends the save again', async () => {
    const { client, puts } = forgetfulServer();
    const first = mount(client);
    fireEvent.click(await screen.findByRole('button', { name: 'Skip tour' }));
    await waitFor(() => expect(puts).toEqual([{ tour: 'my_day', outcome: 'skipped' }]));
    first.unmount();

    // A new visit: the server still says "not seen".
    mount(client);
    await waitFor(() => expect(puts.length).toBe(2));
    expect(puts[1]).toEqual({ tour: 'my_day', outcome: 'skipped' });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('does not open again after Done', async () => {
    const { client } = forgetfulServer();
    const first = mount(client);
    for (let step = 0; step < 2; step += 1) {
      fireEvent.click(await screen.findByRole('button', { name: 'Next' }));
    }
    fireEvent.click(await screen.findByRole('button', { name: 'Done' }));
    first.unmount();
    mount(client);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('anchors Board steps 1 and 2 to the board, also when it is drawn after the tour opens', async () => {
    const { client } = forgetfulServer();
    mount(client, 'work_board');
    expect(await screen.findByText('1 of 3')).toBeTruthy();
    // The board arrives after the tour opened.
    const board = document.createElement('div');
    board.className = 'tm-wk-board';
    board.innerHTML =
      '<section class="tm-wk-board__column"><ul><li class="tm-wk-card-tile">Card</li></ul></section>';
    document.body.appendChild(board);
    const column = board.querySelector('.tm-wk-board__column') as HTMLElement;
    await waitFor(() => expect(column.hasAttribute('data-coach-active')).toBe(true));

    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    const card = board.querySelector('.tm-wk-card-tile') as HTMLElement;
    await waitFor(() => expect(card.hasAttribute('data-coach-active')).toBe(true));
  });
});
