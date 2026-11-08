import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ApiClient } from '../src/lib/api/client';
import { MeetingNotesScreen } from '../src/components/screens/MeetingNotesScreen';
import { expectNoAxeViolations } from './axe';

/** CAL-01 / MTG-01 third slice (x108) — the meeting notes / decisions read screen. */
function mount(body: unknown, status = 200, meetingId = 'meeting-1') {
  const client = new ApiClient({
    baseUrl: 'https://api.example.test',
    csrfCookieName: 'tm_session_csrf',
    fetch: (() =>
      Promise.resolve(
        new Response(JSON.stringify(body), {
          status,
          headers: { 'content-type': 'application/json' },
        }),
      )) as typeof globalThis.fetch,
    readCsrfToken: () => undefined,
    newCorrelationId: () => 'c',
  });
  const query = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={query}>
      <MeetingNotesScreen
        organizationSlug="northstar"
        organizationName="Northstar Studio"
        meetingId={meetingId}
        client={client}
      />
    </QueryClientProvider>,
  );
}

const NOTES = {
  notes: [
    {
      id: 'n1',
      meetingId: 'meeting-1',
      kind: 'note',
      body: 'Agreed the scope for the next sprint.',
      authorUserId: 'u1',
      createdAt: '2026-09-20T10:00:00.000Z',
    },
    {
      id: 'n2',
      meetingId: 'meeting-1',
      kind: 'decision',
      body: 'Ship the read screen before the write side.',
      authorUserId: 'u2',
      createdAt: '2026-09-20T10:05:00.000Z',
    },
  ],
};

describe('MeetingNotesScreen', () => {
  it('renders notes and decisions in server order, with decisions drawn distinctly from notes', async () => {
    const { container } = mount(NOTES);
    expect(await screen.findByText('Agreed the scope for the next sprint.')).toBeTruthy();
    expect(screen.getByText('Ship the read screen before the write side.')).toBeTruthy();

    // A decision carries its own word — never colour alone — so the distinction is accessible.
    expect(screen.getByText('Decision')).toBeTruthy();
    expect(screen.getByText('Note')).toBeTruthy();

    // The order down the list is the server's, not a client re-sort. Scope to the notes region so
    // the AppShell navigation rail (also a list) does not bleed into the query.
    const region = screen.getByRole('region', { name: 'Meeting notes and decisions' });
    const items = within(region).getAllByRole('listitem');
    expect(items).toHaveLength(2);
    expect((items[0] as HTMLElement).textContent).toContain('Agreed the scope');
    expect((items[1] as HTMLElement).textContent).toContain('Ship the read screen');

    await expectNoAxeViolations(container);
  });

  it('shows a not-found state for an unknown or cross-tenant meeting, leaking no data (Known trap)', async () => {
    mount({ error: { code: 'not_found', message: 'Not found.', correlationId: 'c' } }, 404);
    await waitFor(() => expect(screen.getByText('Meeting not found')).toBeTruthy());
    // No notes region, and none of the seeded bodies leak into the not-found page. (The query is
    // scoped to the notes region so the AppShell navigation list is not mistaken for note data.)
    expect(screen.queryByRole('region', { name: 'Meeting notes and decisions' })).toBeNull();
    expect(screen.queryByText(/Agreed the scope/)).toBeNull();
  });

  it('renders an empty state rather than a blank page when a meeting has no notes', async () => {
    mount({ notes: [] });
    await waitFor(() => expect(screen.getByText('No notes yet')).toBeTruthy());
  });

  it('renders the API refusal rather than a blank page', async () => {
    mount({ error: { code: 'forbidden', message: 'No access.', correlationId: 'c' } }, 403);
    await waitFor(() => expect(screen.getByText('No access.')).toBeTruthy());
  });

  it('shows an AI draft for review and saves it with the edits (53-13)', async () => {
    const calls: { url: string; method: string; body: unknown }[] = [];
    let saved = false;
    const client = new ApiClient({
      baseUrl: 'https://api.example.test',
      csrfCookieName: 'tm_session_csrf',
      fetch: ((url: string, init?: RequestInit) => {
        const method = init?.method ?? 'GET';
        calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : null });
        const draft = { id: 'd1', meetingId: 'meeting-1', kind: 'note', body: 'Launch moves', authorUserId: 'u1', source: 'mcp', assistantName: 'Claude', submittedAt: '2026-11-08T10:42:00.000Z' }; // prettier-ignore
        if (method === 'POST') saved = true;
        const body = url.endsWith('/note-drafts')
          ? { drafts: saved ? [] : [draft] }
          : url.endsWith('/review')
            ? { decision: 'save', note: null }
            : { notes: [] };
        return Promise.resolve(new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })); // prettier-ignore
      }) as typeof globalThis.fetch,
      readCsrfToken: () => undefined,
      newCorrelationId: () => 'c',
    });
    const query = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={query}>
        <MeetingNotesScreen
          organizationSlug="northstar"
          organizationName="N"
          meetingId="meeting-1"
          client={client}
        />
      </QueryClientProvider>,
    );
    const region = await screen.findByRole('region', { name: 'Drafts from your AI assistant' });
    expect(within(region).getByText(/Claude/)).toBeTruthy();
    fireEvent.change(within(region).getByLabelText('Draft text'), {
      target: { value: 'Launch moves to 20 Nov' },
    });
    fireEvent.click(within(region).getByRole('button', { name: 'Decision' }));
    fireEvent.click(within(region).getByRole('button', { name: 'Save note' }));
    await waitFor(() =>
      expect(screen.queryByRole('region', { name: 'Drafts from your AI assistant' })).toBeNull(),
    );
    expect(calls.find((c) => c.method === 'POST')).toMatchObject({
      url: expect.stringContaining('/note-drafts/d1/review'),
      body: { decision: 'save', kind: 'decision', body: 'Launch moves to 20 Nov' },
    });
  });
});
