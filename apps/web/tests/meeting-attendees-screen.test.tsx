import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it } from 'vitest';
import { MeetingAttendeesScreen } from '../src/components/screens/MeetingAttendeesScreen';
import { ApiClient } from '../src/lib/api/client';
import { expectNoAxeViolations } from './axe';

/**
 * CAL-01 / MTG-01 attendees + RSVP web (x126). The API's tenant scoping, the
 * `meeting.read`/`meeting.write` gates and the 404-not-403 / 409 refusals are proved in the
 * controller unit test and the chain's DB suites; nothing here re-proves them. What only this file
 * proves is what the *screen* does with those answers:
 *
 * - it lists a meeting's attendees by name (resolving `userId` through the member directory) with a
 *   distinct RSVP capsule, and the mounted document is axe-clean (A11Y-01);
 * - the invite picker offers only members not already invited, and posts the chosen `userId`;
 * - changing an attendee's RSVP PATCHes it.
 */

interface Call {
  readonly url: string;
  readonly method: string;
  readonly body: string | undefined;
}

function clientOver(handler: (call: Call) => Response): { client: ApiClient; calls: Call[] } {
  const calls: Call[] = [];
  const client = new ApiClient({
    baseUrl: 'https://api.example.test',
    csrfCookieName: 'tm_session_csrf',
    fetch: ((input: RequestInfo | URL, init?: RequestInit) => {
      const call: Call = {
        url: String(input),
        method: init?.method ?? 'GET',
        body: typeof init?.body === 'string' ? init.body : undefined,
      };
      calls.push(call);
      return Promise.resolve(handler(call));
    }) as typeof globalThis.fetch,
    readCsrfToken: () => 'csrf-token',
    newCorrelationId: () => 'correlation-fixed',
  });
  return { client, calls };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function withQuery(children: ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

const MEETING = 'meeting-1';
const NOW = '2026-09-01T12:00:00.000Z';

const members = [
  { userId: 'user-ada', displayName: 'Ada Lovelace', role: 'member', status: 'active' },
  { userId: 'user-bo', displayName: 'Bo Diaz', role: 'member', status: 'active' },
];

function routeBase(call: Call): Response {
  if (call.url.includes(`/meetings/${MEETING}/attendees`)) {
    return json({
      attendees: [
        { id: 'att-1', meetingId: MEETING, userId: 'user-ada', rsvp: 'invited', createdAt: NOW },
      ],
    });
  }
  if (call.url.includes('/members')) {
    return json({ members, nextAfter: null });
  }
  return json({}, 200);
}

describe('MeetingAttendeesScreen', () => {
  it("lists a meeting's attendees by name with an RSVP, offers only uninvited members, and is axe-clean", async () => {
    const { client } = clientOver(routeBase);
    const { container } = render(
      withQuery(
        <MeetingAttendeesScreen
          organizationSlug="acme"
          organizationName="Acme"
          meetingId={MEETING}
          client={client}
        />,
      ),
    );

    // The attendee is named through the directory, not shown as an opaque id.
    await screen.findByText('Ada Lovelace');
    // The RSVP is surfaced as a distinct capsule, not just the editable dropdown's selected option.
    expect(screen.getByText('Invited', { selector: '.tm-state-capsule' })).toBeTruthy();

    // The picker offers Bo (not invited) but not Ada (already an attendee).
    const picker = await screen.findByLabelText('Member');
    expect(screen.getByRole('option', { name: 'Bo Diaz' })).toBeTruthy();
    expect(screen.queryByRole('option', { name: 'Ada Lovelace' })).toBeNull();
    expect(picker).toBeTruthy();

    await expectNoAxeViolations(container);
  });

  it('posts the chosen member as userId when inviting, and PATCHes an RSVP change', async () => {
    const posted: Call[] = [];
    const patched: Call[] = [];
    const { client } = clientOver((call) => {
      if (call.method === 'POST' && call.url.includes('/attendees')) {
        posted.push(call);
        return json(
          { id: 'att-2', meetingId: MEETING, userId: 'user-bo', rsvp: 'invited', createdAt: NOW },
          201,
        );
      }
      if (call.method === 'PATCH' && call.url.includes('/attendees/')) {
        patched.push(call);
        return json({
          id: 'att-1',
          meetingId: MEETING,
          userId: 'user-ada',
          rsvp: 'accepted',
          createdAt: NOW,
        });
      }
      return routeBase(call);
    });

    render(
      withQuery(
        <MeetingAttendeesScreen
          organizationSlug="acme"
          organizationName="Acme"
          meetingId={MEETING}
          client={client}
        />,
      ),
    );

    await screen.findByText('Ada Lovelace');

    fireEvent.change(screen.getByLabelText('Member'), { target: { value: 'user-bo' } });
    fireEvent.click(screen.getByRole('button', { name: 'Invite member' }));
    await waitFor(() => expect(posted.length).toBe(1));
    expect((JSON.parse(posted[0]!.body as string) as Record<string, unknown>)['userId']).toBe(
      'user-bo',
    );

    fireEvent.change(screen.getByLabelText('RSVP for Ada Lovelace'), {
      target: { value: 'accepted' },
    });
    await waitFor(() => expect(patched.length).toBe(1));
    expect((JSON.parse(patched[0]!.body as string) as Record<string, unknown>)['rsvp']).toBe(
      'accepted',
    );
  });
});
