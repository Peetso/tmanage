import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it } from 'vitest';
import {
  ProjectIterationsScreen,
  completionTargets,
  defaultIterationId,
} from '../src/components/screens/ProjectIterationsScreen';
import { ApiClient } from '../src/lib/api/client';
import { burnUpBars } from '../src/lib/api/iterations';
import type { IterationSummary } from '../src/lib/api/iterations';

/**
 * 53-21 iterations screen (Figma 590:33385). The API's gates, the roll-over transaction and the
 * burndown maths are proved in `iterations.service.test.ts`; this file proves what the screen
 * does: which iteration it opens on, the burn-up it draws, and the requests its actions send.
 */

interface Call {
  readonly url: string;
  readonly method: string;
  readonly body: unknown;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function iteration(id: string, phase: IterationSummary['phase'], name: string): IterationSummary {
  return {
    id,
    projectId: 'p1',
    name,
    goal: null,
    startsOn: '2026-11-03',
    endsOn: '2026-11-14',
    status: phase === 'completed' ? 'completed' : 'open',
    phase,
    completedAt: null,
    version: 2,
    itemCount: 1,
    committedPoints: 5,
    donePoints: 0,
    daysLeft: 3,
  };
}

const LIST = {
  projectId: 'p1',
  pointsEnabled: true,
  iterations: [
    iteration('it-11', 'completed', 'Sprint 11'),
    iteration('it-12', 'active', 'Sprint 12'),
    iteration('it-13', 'planned', 'Sprint 13'),
  ],
};

function harness() {
  const calls: Call[] = [];
  const client = new ApiClient({
    baseUrl: 'https://api.example.test',
    csrfCookieName: 'tm_session_csrf',
    fetch: ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      if (url.endsWith('/projects/p1/iterations') && method === 'GET')
        return Promise.resolve(json(LIST));
      if (url.endsWith('/iterations/it-12/burndown')) {
        return Promise.resolve(
          json({
            iterationId: 'it-12',
            points: [
              {
                date: '2026-11-03',
                workingDay: true,
                scope: 5,
                scopeItems: 1,
                remainingPoints: 5,
                remainingItems: 1,
              },
            ],
          }),
        );
      }
      if (url.endsWith('/iterations/it-12') && method === 'GET') {
        return Promise.resolve(
          json({
            ...LIST.iterations[1],
            items: [{ id: 'w1', title: 'Design checkout', state: 'in_progress', points: 5 }],
          }),
        );
      }
      if (url.includes('/work-items')) {
        return Promise.resolve(
          json({
            workItems: [
              { id: 'w2', projectId: 'p1', title: 'Wire payments', state: 'not_started' },
            ],
          }),
        );
      }
      if (url.endsWith('/items')) return Promise.resolve(json({ added: 1, removed: 0 }));
      if (url.endsWith('/complete')) {
        return Promise.resolve(
          json({
            iterationId: 'it-12',
            moved: 1,
            left: 0,
            movedTo: 'it-13',
            alreadyCompleted: false,
          }),
        );
      }
      return Promise.resolve(json({}, 404));
    }) as typeof globalThis.fetch,
    readCsrfToken: () => 'csrf',
    newCorrelationId: () => 'corr',
  });
  return { client, calls };
}

function withQuery(children: ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

describe('iterations helpers (53-21)', () => {
  it('opens on the active iteration, else the next planned one', () => {
    expect(defaultIterationId(LIST.iterations)).toBe('it-12');
    expect(defaultIterationId([LIST.iterations[0]!, LIST.iterations[2]!])).toBe('it-13');
    expect(defaultIterationId([])).toBeNull();
  });

  it('offers only other open iterations as the roll-over target', () => {
    expect(completionTargets(LIST.iterations, 'it-12').map((i) => i.id)).toEqual(['it-13']);
  });

  it('turns the burndown into burn-up bars on working days only', () => {
    const bars = burnUpBars(
      [
        {
          date: 'a',
          workingDay: true,
          scope: 10,
          scopeItems: 4,
          remainingPoints: 6,
          remainingItems: 3,
        },
        {
          date: 'b',
          workingDay: false,
          scope: 10,
          scopeItems: 4,
          remainingPoints: 6,
          remainingItems: 3,
        },
      ],
      true,
    );
    expect(bars).toEqual([{ date: 'a', scope: 10, done: 4 }]);
    expect(
      burnUpBars(
        [
          {
            date: 'a',
            workingDay: true,
            scope: 10,
            scopeItems: 4,
            remainingPoints: 6,
            remainingItems: 3,
          },
        ],
        false,
      ),
    ).toEqual([{ date: 'a', scope: 4, done: 1 }]);
  });
});

describe('ProjectIterationsScreen (53-21)', () => {
  it('shows the active iteration with its work and burn-up, and adds work to it', async () => {
    const { client, calls } = harness();
    render(
      withQuery(
        <ProjectIterationsScreen
          organizationSlug="acme"
          organizationName="Acme"
          projectId="p1"
          client={client}
        />,
      ),
    );

    expect(await screen.findByText('Design checkout')).toBeInTheDocument();
    expect(screen.getByRole('img', { name: /Burn-up chart/ })).toBeInTheDocument();

    const picker = await screen.findByLabelText('Add work from this project');
    await screen.findByRole('option', { name: 'Wire payments' });
    fireEvent.change(picker, { target: { value: 'w2' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    await waitFor(() =>
      expect(calls.some((c) => c.url.endsWith('/iterations/it-12/items'))).toBe(true),
    );
    expect(calls.find((c) => c.url.endsWith('/items'))?.body).toEqual({ add: ['w2'] });
  });

  it('completes the iteration and rolls unfinished work to the chosen iteration', async () => {
    const { client, calls } = harness();
    render(
      withQuery(
        <ProjectIterationsScreen
          organizationSlug="acme"
          organizationName="Acme"
          projectId="p1"
          client={client}
        />,
      ),
    );

    const target = await screen.findByLabelText('Move unfinished work to');
    fireEvent.change(target, { target: { value: 'it-13' } });
    fireEvent.click(screen.getByRole('button', { name: 'Complete iteration' }));
    await waitFor(() => expect(calls.some((c) => c.url.endsWith('/complete'))).toBe(true));
    expect(calls.find((c) => c.url.endsWith('/complete'))?.body).toEqual({
      moveUnfinishedTo: 'it-13',
    });
  });
});
