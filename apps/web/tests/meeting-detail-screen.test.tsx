import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it } from 'vitest';
import { MeetingDetailScreen } from '../src/components/screens/MeetingDetailScreen';
import { ApiClient } from '../src/lib/api/client';
import { expectNoAxeViolations } from './axe';

/**
 * A5 — the meeting detail and its edit (Figma `mt-saved` / `mt-edit`). The API's validation (end
 * after start), tenant scoping and the client-of-this-project rule are proved beside the
 * controllers; what only this file proves is what the *screen* sends and draws:
 *
 * - the saved card's Date / Time / Attendees (Organizer, Accepted, Invited, Client) / Notes rows;
 * - Save sends `PATCH .../meetings/:id` with an end after the start, and refuses an earlier end
 *   without a request;
 * - × on a chip removes that attendee with `DELETE .../attendees/:id` on save;
 * - a client chosen in "+ Add people" is invited as `clientUserId`, never `userId`.
 */

interface Call {
  readonly url: string;
  readonly method: string;
  readonly body: string | undefined;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const MEETING = 'meeting-1';
const PROJECT = 'project-1';
const NOW = '2026-10-20T12:00:00.000Z';
// Local wall-clock times, so the assertions hold in any test-runner zone.
const STARTS = new Date(2026, 9, 29, 10, 0).toISOString();
const ENDS = new Date(2026, 9, 29, 11, 0).toISOString();

const meeting = {
  id: MEETING,
  projectId: PROJECT,
  title: 'Weekly client review',
  startsAt: STARTS,
  endsAt: ENDS,
  agendaNote: 'Review the mobile booking flow.',
  createdByUserId: 'user-maya',
  createdAt: NOW,
  updatedAt: NOW,
};

const project = {
  id: PROJECT,
  workspaceId: 'ws-1',
  name: 'Atlas relaunch',
  status: 'active',
  ownerUserId: null,
  committedAt: null,
  forecastAt: null,
  createdAt: NOW,
  updatedAt: NOW,
  archivedAt: null,
};

const members = [
  { userId: 'user-maya', displayName: 'Maya Hassan', role: 'owner', status: 'active' },
  { userId: 'user-lina', displayName: 'Lina Samir', role: 'member', status: 'active' },
  { userId: 'user-yomna', displayName: 'Yomna Adel', role: 'member', status: 'active' },
];

function mount(extra?: (call: Call) => Response | undefined) {
  const calls: Call[] = [];
  const api = new ApiClient({
    baseUrl: 'https://api.example.test',
    csrfCookieName: 'tm_session_csrf',
    fetch: ((input: RequestInfo | URL, init?: RequestInit) => {
      const call: Call = {
        url: String(input),
        method: init?.method ?? 'GET',
        body: typeof init?.body === 'string' ? init.body : undefined,
      };
      calls.push(call);
      return Promise.resolve(extra?.(call) ?? route(call));
    }) as typeof globalThis.fetch,
    readCsrfToken: () => 'csrf-token',
    newCorrelationId: () => 'correlation-fixed',
  });
  const queries = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const wrap = (children: ReactNode) => (
    <QueryClientProvider client={queries}>{children}</QueryClientProvider>
  );
  const view = render(
    wrap(
      <MeetingDetailScreen
        organizationSlug="acme"
        organizationName="Northstar Studio"
        meetingId={MEETING}
        client={api}
      />,
    ),
  );
  return { calls, view };
}

function route(call: Call): Response {
  const { url, method } = call;
  if (url.includes('/attendees/client-candidates')) {
    return json({
      candidates: [
        {
          userId: 'client-youssef',
          displayName: 'Youssef Kamal',
          clientOrganizationId: 'co-1',
          clientOrganizationName: 'Atlas Hospitality',
        },
      ],
    });
  }
  if (url.includes(`/meetings/${MEETING}/attendees`) && method === 'GET') {
    return json({
      attendees: [
        { id: 'att-1', meetingId: MEETING, userId: 'user-maya', rsvp: 'accepted', createdAt: NOW },
        { id: 'att-2', meetingId: MEETING, userId: 'user-lina', rsvp: 'invited', createdAt: NOW },
      ],
      clientAttendees: [
        {
          id: 'catt-1',
          meetingId: MEETING,
          userId: 'client-salma',
          displayName: 'Salma Riad',
          clientOrganizationId: 'co-1',
          clientOrganizationName: 'Atlas Hospitality',
          rsvp: 'accepted',
          createdAt: NOW,
        },
      ],
    });
  }
  if (url.includes(`/meetings/${MEETING}/attendees`) && method === 'DELETE') {
    return new Response(null, { status: 204 });
  }
  if (url.includes(`/meetings/${MEETING}/attendees`) && method === 'POST') {
    return json({ id: 'att-new', meetingId: MEETING, rsvp: 'invited', createdAt: NOW }, 201);
  }
  if (url.includes(`/meetings/${MEETING}`) && method === 'PATCH') {
    return json({ ...meeting, ...(JSON.parse(call.body ?? '{}') as object) });
  }
  if (url.includes('/meetings?')) return json({ meetings: [meeting] });
  if (url.includes(`/projects/${PROJECT}`)) return json(project);
  if (url.includes('/projects')) return json({ projects: [project] });
  if (url.includes('/members')) return json({ members, nextAfter: null });
  return json({});
}

async function openEdit() {
  fireEvent.click(await screen.findByRole('button', { name: 'Edit meeting' }));
  return screen.findByRole('form', { name: 'Edit meeting' });
}

describe('MeetingDetailScreen', () => {
  it('draws the saved card: date, time, attendees with their pills, and the notes', async () => {
    const { view } = mount();

    await screen.findByRole('heading', { level: 1, name: 'Weekly client review' });
    const card = await screen.findByRole('region', { name: 'Meeting details' });
    expect(within(card).getByText('Thursday, 29 October 2026')).toBeTruthy();
    expect(within(card).getByText('10:00 – 11:00')).toBeTruthy();

    const maya = (await within(card).findByText('Maya Hassan')).closest('li') as HTMLElement;
    expect(within(maya).getByText('Organizer')).toBeTruthy();
    const lina = within(card).getByText('Lina Samir').closest('li') as HTMLElement;
    expect(within(lina).getByText('Invited')).toBeTruthy();
    const salma = within(card).getByText('Salma Riad').closest('li') as HTMLElement;
    expect(within(salma).getByText('Client')).toBeTruthy();
    expect(within(salma).getByText('Accepted')).toBeTruthy();

    expect(within(card).getByText('Review the mobile booking flow.')).toBeTruthy();
    expect(await screen.findByText('Atlas relaunch · Meetings')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Add to calendar' }).getAttribute('href')).toMatch(
      /\/meetings\/meeting-1\/ics$/,
    );

    await expectNoAxeViolations(view.container);
  });

  it('saves with PATCH when the end is after the start, and refuses an earlier end', async () => {
    const { calls } = mount();
    const form = await openEdit();

    fireEvent.change(within(form).getByLabelText('Title'), {
      target: { value: 'Client review' },
    });
    fireEvent.change(within(form).getByLabelText('Ends'), { target: { value: '09:30' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(await screen.findByText('The meeting has to end after it starts.')).toBeTruthy();
    expect(calls.some((call) => call.method === 'PATCH')).toBe(false);

    fireEvent.change(within(form).getByLabelText('Ends'), { target: { value: '11:30' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    await screen.findByText('Meeting saved');
    expect(screen.getByText('New attendees get an invitation.')).toBeTruthy();
    const patch = calls.find((call) => call.method === 'PATCH');
    expect(patch?.url).toMatch(/\/meetings\/meeting-1$/);
    const body = JSON.parse(patch?.body ?? '{}') as Record<string, string>;
    expect(body['title']).toBe('Client review');
    expect(body['startsAt']).toBe(STARTS);
    expect(body['endsAt']).toBe(new Date(2026, 9, 29, 11, 30).toISOString());
    expect(Date.parse(body['endsAt'] ?? '')).toBeGreaterThan(Date.parse(body['startsAt'] ?? ''));
  });

  it('removes an attendee with DELETE on save', async () => {
    const { calls } = mount();
    const form = await openEdit();

    fireEvent.click(await within(form).findByRole('button', { name: 'Remove Lina Samir' }));
    expect(within(form).queryByText('Lina Samir')).toBeNull();
    // The organizer has no remove control.
    expect(within(form).queryByRole('button', { name: 'Remove Maya Hassan' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    await screen.findByText('Meeting saved');
    const removal = calls.find((call) => call.method === 'DELETE');
    expect(removal?.url).toMatch(/\/meetings\/meeting-1\/attendees\/att-2$/);
  });

  it('invites a client of this project as clientUserId', async () => {
    const { calls } = mount();
    const form = await openEdit();

    fireEvent.click(within(form).getByRole('button', { name: '+ Add people' }));
    const picker = await screen.findByRole('dialog', { name: 'Add people' });
    expect(within(picker).getByText('Clients on Atlas relaunch')).toBeTruthy();
    // People already on the meeting are not offered again.
    await within(picker).findByText('Yomna Adel');
    expect(within(picker).queryByText('Lina Samir')).toBeNull();

    fireEvent.click(await within(picker).findByRole('button', { name: /Youssef Kamal/ }));
    expect(within(form).getByText('Youssef Kamal')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    await screen.findByText('Meeting saved');
    const invite = calls.find((call) => call.method === 'POST');
    expect(invite?.url).toMatch(/\/meetings\/meeting-1\/attendees$/);
    expect(JSON.parse(invite?.body ?? '{}')).toEqual({ clientUserId: 'client-youssef' });
  });
});
