import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { WorkBoardView } from '../src/components/screens/WorkBoardView';
import { WorkCalendarScreen } from '../src/components/screens/WorkCalendarScreen';
import { ApiClient } from '../src/lib/api/client';
import { ApiRequestError } from '../src/lib/api/errors';
import type { WorkItemSummary } from '../src/lib/api/work-items';
import {
  byRank,
  datesForDayDrop,
  moveBefore,
  rankForDrop,
  workDragPermissions,
} from '../src/lib/work-drag';

/**
 * FIX3 item C — "make the tasks draggable": the hand-made order (rank), the drop on another
 * day, who may drag, and that a refused drop is rolled back with a message.
 */

function item(id: string, overrides: Partial<WorkItemSummary> = {}): WorkItemSummary {
  return {
    id,
    projectId: 'proj-1',
    type: 'task',
    title: id,
    description: null,
    state: 'ready',
    ownerUserId: null,
    audience: 'internal',
    startAt: null,
    dueAt: null,
    completedAt: null,
    version: 3,
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
    deletedAt: null,
    ...overrides,
  };
}

function dataTransfer() {
  const data = new Map<string, string>();
  return {
    setData: (k: string, v: string) => data.set(k, v),
    getData: (k: string) => data.get(k) ?? '',
    effectAllowed: 'move',
    dropEffect: 'move',
  };
}

describe('the hand-made order', () => {
  const a = item('A', { rank: 100 });
  const b = item('B', { rank: 200 });
  const c = item('C', { rank: 300 });

  it('sorts by rank, and a never-dragged item by when it was made', () => {
    const late = item('Late', { createdAt: '2026-10-02T00:00:00.000Z' });
    const early = item('Early', { createdAt: '2026-10-01T00:00:00.000Z' });
    expect(byRank([late, early]).map((x) => x.id)).toEqual(['Early', 'Late']);
    expect(byRank([c, a, b]).map((x) => x.id)).toEqual(['A', 'B', 'C']);
  });

  it('places a dropped item between its new neighbours with one key', () => {
    expect(rankForDrop([a, b, c], 'C', 'B')).toBe(150);
    expect(rankForDrop([a, b, c], 'A', null)).toBe(300 + 60_000);
    expect(rankForDrop([a, b, c], 'C', 'A')).toBe(100 - 60_000);
    // Dropped where it already is: nothing to write.
    expect(rankForDrop([a, b, c], 'B', 'C')).toBeNull();
    expect(moveBefore([a, b, c], 'C', 'A').map((x) => x.id)).toEqual(['C', 'A', 'B']);
  });

  it('moves start and due together to the day dropped on', () => {
    expect(
      datesForDayDrop(
        { startAt: '2026-11-03T09:00:00.000Z', dueAt: '2026-11-05T17:00:00.000Z' },
        '2026-11-05',
        '2026-11-08',
      ),
    ).toEqual({ startAt: '2026-11-06T09:00:00.000Z', dueAt: '2026-11-08T17:00:00.000Z' });
    expect(datesForDayDrop({ startAt: null, dueAt: null }, '2026-11-05', '2026-11-05')).toBeNull();
  });

  it('lets only internal people with the capability drag', () => {
    expect(workDragPermissions(undefined)).toEqual({ canUpdate: false, canTransition: false });
    expect(
      workDragPermissions({ kind: 'client', capabilities: ['work.update', 'work.transition'] }),
    ).toEqual({ canUpdate: false, canTransition: false });
    expect(workDragPermissions({ kind: 'internal', capabilities: ['work.read'] })).toEqual({
      canUpdate: false,
      canTransition: false,
    });
    expect(
      workDragPermissions({ kind: 'internal', capabilities: ['work.update', 'work.transition'] }),
    ).toEqual({ canUpdate: true, canTransition: true });
  });
});

describe('Board: reorder inside a column', () => {
  const cards = [
    item('First', { rank: 1000 }),
    item('Second', { rank: 2000 }),
    item('Third', { rank: 3000 }),
  ];

  function column() {
    return screen.getAllByRole('link').map((link) => link.textContent);
  }

  it('drops a card before another one and saves its new rank', async () => {
    const request = vi.fn(async ({ body }: { body: { version: number; rank: number } }) => ({
      data: item('Third', { rank: body.rank, version: body.version + 1 }),
    }));
    render(
      <WorkBoardView
        organizationSlug="northstar"
        items={cards}
        members={[]}
        membersPending={false}
        api={{ request } as unknown as ApiClient}
      />,
    );
    const dragged = screen.getByRole('link', { name: 'Third' }).closest('li') as HTMLElement;
    const target = screen.getByRole('link', { name: 'First' }).closest('li') as HTMLElement;
    const transfer = dataTransfer();
    fireEvent.dragStart(dragged, { dataTransfer: transfer });
    fireEvent.dragOver(target, { dataTransfer: transfer });
    fireEvent.drop(target, { dataTransfer: transfer });
    // Optimistic: it is first at once.
    expect(column()).toEqual(['Third', 'First', 'Second']);
    await waitFor(() => expect(request).toHaveBeenCalledTimes(1));
    expect(request.mock.calls[0]?.[0]).toMatchObject({
      method: 'PATCH',
      body: { version: 3, rank: 1000 - 60_000 },
    });
  });

  it('puts the card back and says why when the API refuses', async () => {
    const request = vi.fn(async () => {
      throw new ApiRequestError(403, 'forbidden', 'You cannot change this work.', 'c-1');
    });
    render(
      <WorkBoardView
        organizationSlug="northstar"
        items={cards}
        members={[]}
        membersPending={false}
        api={{ request } as unknown as ApiClient}
      />,
    );
    const dragged = screen.getByRole('link', { name: 'Third' }).closest('li') as HTMLElement;
    const target = screen.getByRole('link', { name: 'First' }).closest('li') as HTMLElement;
    const transfer = dataTransfer();
    fireEvent.dragStart(dragged, { dataTransfer: transfer });
    fireEvent.dragOver(target, { dataTransfer: transfer });
    fireEvent.drop(target, { dataTransfer: transfer });
    expect(await screen.findByText(/You cannot change this work\./)).toBeInTheDocument();
    expect(column()).toEqual(['First', 'Second', 'Third']);
  });

  it('offers no drag and no Move menu to someone who may not change work', () => {
    render(
      <WorkBoardView
        organizationSlug="northstar"
        items={cards}
        members={[]}
        membersPending={false}
        api={{ request: vi.fn() } as unknown as ApiClient}
        dragRights={{ canUpdate: false, canTransition: false }}
      />,
    );
    const card = screen.getByRole('link', { name: 'First' }).closest('li') as HTMLElement;
    expect(card.getAttribute('draggable')).toBeNull();
    expect(within(card).queryByRole('button')).toBeNull();
  });

  it('keeps a keyboard path: Move → Up one place', async () => {
    const request = vi.fn(async ({ body }: { body: { version: number; rank: number } }) => ({
      data: item('Second', { rank: body.rank }),
    }));
    render(
      <WorkBoardView
        organizationSlug="northstar"
        items={cards}
        members={[]}
        membersPending={false}
        api={{ request } as unknown as ApiClient}
      />,
    );
    const card = screen.getByRole('link', { name: 'Second' }).closest('li') as HTMLElement;
    fireEvent.click(within(card).getByRole('button', { name: /Second/ }));
    fireEvent.click(within(card).getByRole('button', { name: 'Up one place' }));
    await waitFor(() => expect(request).toHaveBeenCalledTimes(1));
    expect(request.mock.calls[0]?.[0]).toMatchObject({ body: { rank: 1000 - 60_000 } });
  });
});

describe('Calendar: drag an item to another day', () => {
  function harness(patch: 'ok' | 'refuse') {
    const calls: { url: string; method: string; body: unknown }[] = [];
    const reply = (status: number, body: unknown) =>
      Promise.resolve(
        new Response(JSON.stringify(body), {
          status,
          headers: { 'content-type': 'application/json' },
        }),
      );
    const client = new ApiClient({
      baseUrl: 'https://api.example.test',
      csrfCookieName: 'tm_session_csrf',
      fetch: ((input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = init?.method ?? 'GET';
        calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
        if (url.endsWith('/me')) {
          return reply(200, {
            membershipId: 'm-1',
            userId: 'u-1',
            kind: 'internal',
            role: 'member',
            capabilities: ['work.update'],
          });
        }
        if (url.includes('/work-views/calendar/')) {
          return reply(200, {
            projectId: 'proj-1',
            range: { from: '2026-11-01', to: '2026-11-30' },
            days: [
              {
                date: '2026-11-05',
                items: [
                  {
                    id: 'w-1',
                    title: 'Logo concepts',
                    state: 'ready',
                    startAt: null,
                    dueAt: '2026-11-05T17:00:00.000Z',
                  },
                ],
              },
            ],
          });
        }
        if (url.endsWith('/work-items/w-1') && method === 'GET') {
          return reply(200, item('w-1', { version: 7, dueAt: '2026-11-05T17:00:00.000Z' }));
        }
        if (url.endsWith('/work-items/w-1') && method === 'PATCH') {
          return patch === 'ok'
            ? reply(200, item('w-1', { version: 8, dueAt: '2026-11-09T17:00:00.000Z' }))
            : reply(409, {
                error: {
                  code: 'version_conflict',
                  message: 'Someone else changed this item. Reload and try again.',
                  correlationId: 'c-2',
                },
              });
        }
        return reply(200, { projects: [{ id: 'proj-1', name: 'Brand refresh' }] });
      }) as typeof globalThis.fetch,
      readCsrfToken: () => 'csrf-token',
      newCorrelationId: () => 'correlation-fixed',
    });
    const queries = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queries}>
        <WorkCalendarScreen
          organizationSlug="acme"
          organizationName="Acme"
          initialProjectId="proj-1"
          initialFrom="2026-11-01"
          initialTo="2026-11-30"
          client={client}
          now={new Date('2026-11-04T12:00:00.000Z')}
        />
      </QueryClientProvider>,
    );
    return calls;
  }

  function cellOf(day: string): HTMLElement {
    const label = screen.getAllByText(day).find((node) => node.closest('td'));
    return label?.closest('td') as HTMLElement;
  }

  async function drag(calls: { url: string }[]) {
    const link = await screen.findByRole('link', { name: /Logo concepts/ });
    await waitFor(() => expect(link.getAttribute('draggable')).toBe('true'));
    expect(calls.some((c) => c.url.endsWith('/me'))).toBe(true);
    const transfer = dataTransfer();
    fireEvent.dragStart(link, { dataTransfer: transfer });
    const target = cellOf('9');
    fireEvent.dragOver(target, { dataTransfer: transfer });
    fireEvent.drop(target, { dataTransfer: transfer });
    return target;
  }

  it('moves the due date by the days travelled, with the current version', async () => {
    const calls = harness('ok');
    const target = await drag(calls);
    expect(within(target).getByRole('link', { name: /Logo concepts/ })).toBeInTheDocument();
    await waitFor(() => expect(calls.some((c) => c.method === 'PATCH')).toBe(true));
    expect(calls.find((c) => c.method === 'PATCH')?.body).toEqual({
      version: 7,
      startAt: null,
      dueAt: '2026-11-09T17:00:00.000Z',
    });
  });

  it('puts the item back on its day and says why when the save is refused', async () => {
    const calls = harness('refuse');
    await drag(calls);
    expect(await screen.findByText(/Someone else changed this item/)).toBeInTheDocument();
    expect(within(cellOf('5')).getByRole('link', { name: /Logo concepts/ })).toBeInTheDocument();
  });
});
