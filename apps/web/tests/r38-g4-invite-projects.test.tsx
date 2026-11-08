import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ApiClient } from '../src/lib/api/client';
import { filterProjects, InviteClientDialog } from '../src/components/clients/InviteClientDialog';
import { invitationProjectNames } from '../src/components/people/PendingInvitations';

/**
 * R38 G4 (Peter, 2026-11-08): "When I invite, let me tag the client to one or more projects."
 * The client invite dialog's projects are a searchable multi-select whose ids travel on the
 * invitation; the API shares them when the person accepts. Pending rows name the projects.
 */

interface Sent {
  readonly method: string;
  readonly path: string;
  readonly body: unknown;
}

const PROJECTS = [
  { id: 'p-web', name: 'Website relaunch', archivedAt: null },
  { id: 'p-spring', name: 'Spring campaign', archivedAt: null },
  { id: 'p-old', name: 'Old brand', archivedAt: '2026-01-01T00:00:00Z' },
];

function routedClient(sent: Sent[]): ApiClient {
  const routed = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input.toString());
    const method = init?.method ?? 'GET';
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined;
    if (method !== 'GET') sent.push({ method, path: url.pathname, body });
    const reply = (value: unknown, status = 200) =>
      Promise.resolve(
        new Response(JSON.stringify(value), {
          status,
          headers: { 'content-type': 'application/json' },
        }),
      );
    if (url.pathname.endsWith('/projects')) return reply({ projects: PROJECTS });
    if (url.pathname.endsWith('/invitations') && method === 'POST') {
      return reply(
        { invitation: { id: 'inv-1', email: 'y@atlas.test' }, token: 't', delivery: 'sent' },
        201,
      );
    }
    return reply({}, 404);
  }) as typeof globalThis.fetch;
  return new ApiClient({
    baseUrl: 'https://api.example.test',
    csrfCookieName: 'tm_session_csrf',
    fetch: routed,
    readCsrfToken: () => undefined,
    newCorrelationId: () => 'c',
  });
}

describe('R38 G4: tag a client invitation with projects', () => {
  it('searches projects by name, ignoring case and accents', () => {
    const list = [{ name: 'Café menu' }, { name: 'Website relaunch' }];
    expect(filterProjects(list, 'CAFE').map((p) => p.name)).toEqual(['Café menu']);
    expect(filterProjects(list, '  ')).toHaveLength(2);
  });

  it('sends every chosen project on the invitation and shares nothing before acceptance', async () => {
    const sent: Sent[] = [];
    let issued = false;
    render(
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <InviteClientDialog
          api={routedClient(sent)}
          organizationSlug="northstar"
          organizations={[
            {
              id: 'co-1',
              name: 'Atlas',
              createdAt: '2026-01-01T00:00:00Z',
              updatedAt: '2026-01-01T00:00:00Z',
              archivedAt: null,
            },
          ]}
          initialCompanyName="Atlas"
          onClose={() => undefined}
          onIssued={() => {
            issued = true;
          }}
        />
      </QueryClientProvider>,
    );

    fireEvent.click(await screen.findByLabelText('Website relaunch'));
    fireEvent.click(screen.getByLabelText('Spring campaign'));
    expect(screen.queryByLabelText('Old brand')).toBeNull();
    fireEvent.change(screen.getByRole('textbox', { name: /email/iu }), {
      target: { value: 'y@atlas.test' },
    });
    fireEvent.submit(screen.getByRole('textbox', { name: /email/iu }).closest('form') as Element);

    await waitFor(() => expect(issued).toBe(true));
    expect(sent).toHaveLength(1);
    expect(sent[0]?.body).toMatchObject({
      clientOrganizationId: 'co-1',
      projectIds: ['p-web', 'p-spring'],
    });
  });

  it('names the tagged projects on a pending invitation row', () => {
    expect(invitationProjectNames({ projects: [{ name: 'A' }, { name: 'B' }] })).toBe('A, B');
    expect(invitationProjectNames({})).toBe('');
  });
});
