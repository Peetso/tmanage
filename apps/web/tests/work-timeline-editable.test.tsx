import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { WorkTimelineScreen } from '../src/components/screens/WorkTimelineScreen';
import { ApiClient } from '../src/lib/api/client';

/**
 * 53-03 Editable Gantt — what only the screen proves: the keyboard path saves one move through the
 * 53-04 cascade (preview, then apply), and a move that would shift other tasks asks first.
 */

interface Call {
  readonly url: string;
  readonly method: string;
  readonly body: unknown;
}

const PROJECT = 'proj-1';
const ITEM = {
  id: 'item-1',
  title: 'Logo concepts',
  state: 'in_progress',
  startAt: '2026-11-03T00:00:00.000Z',
  dueAt: '2026-11-06T00:00:00.000Z',
  predecessorIds: [],
  dependencies: [],
};

function harness(moves: readonly { id: string }[]) {
  const calls: Call[] = [];
  const client = new ApiClient({
    baseUrl: 'https://api.example.test',
    csrfCookieName: 'tm_session_csrf',
    fetch: ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      const body = url.includes('/schedule/cascade')
        ? {
            workItemId: ITEM.id,
            startAt: null,
            dueAt: null,
            moves,
            hiddenCount: 0,
            crossProjectIds: [],
            unscheduled: [],
          }
        : url.includes('/work-views/timeline/')
          ? { projectId: PROJECT, items: [ITEM], phases: [], milestones: [] }
          : { projects: [{ id: PROJECT, name: 'Brand refresh' }] };
      return Promise.resolve(
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    }) as typeof globalThis.fetch,
    readCsrfToken: () => 'csrf-token',
    newCorrelationId: () => 'correlation-fixed',
  });
  const queries = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queries}>
      <WorkTimelineScreen
        organizationSlug="acme"
        organizationName="Acme"
        initialProjectId={PROJECT}
        client={client}
        now={new Date('2026-11-04T12:00:00.000Z')}
      />
    </QueryClientProvider>,
  );
  return calls;
}

describe('53-03 editable timeline', () => {
  it('moves a bar two days by keyboard and saves it once through preview and apply', async () => {
    const calls = harness([]);
    const bar = await screen.findByRole('button', { name: /Logo concepts,/ });
    fireEvent.keyDown(bar, { key: 'ArrowRight' });
    fireEvent.keyDown(bar, { key: 'ArrowRight' });
    await waitFor(() => expect(calls.some((c) => c.url.endsWith('/cascade-apply'))).toBe(true), {
      timeout: 3000,
    });
    const writes = calls.filter((c) => c.method === 'POST');
    expect(writes.map((c) => c.url.split('/').pop())).toEqual(['cascade-preview', 'cascade-apply']);
    expect(writes[1]?.body).toEqual({
      startAt: '2026-11-05T00:00:00.000Z',
      dueAt: '2026-11-08T00:00:00.000Z',
      expectedMoves: [],
    });
    expect(await screen.findByRole('button', { name: 'Undo' })).toBeTruthy();
  });

  it('asks before a move that shifts other tasks, and applies only on confirm', async () => {
    const calls = harness([{ id: 'item-2' }]);
    const bar = await screen.findByRole('button', { name: /Logo concepts,/ });
    fireEvent.keyDown(bar, { key: 'ArrowRight', shiftKey: true });
    const apply = await screen.findByRole('button', { name: 'Apply' }, { timeout: 3000 });
    expect(screen.getByText('This will move 1 more tasks')).toBeTruthy();
    expect(calls.some((c) => c.url.endsWith('/cascade-apply'))).toBe(false);
    fireEvent.click(apply);
    await waitFor(() => expect(calls.some((c) => c.url.endsWith('/cascade-apply'))).toBe(true));
  });
});
