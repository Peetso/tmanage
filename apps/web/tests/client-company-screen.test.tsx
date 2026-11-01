import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ApiClient } from '../src/lib/api/client';
import { ApiRequestError } from '../src/lib/api/errors';
import { ClientCompanyScreen } from '../src/components/screens/ClientCompanyScreen';
import { clientOnlyRead } from '../src/lib/portal-preview';
import { translate, type MessageKey } from '../src/lib/i18n/t';

/**
 * 2026-10-31 live-test fixes — the client company page (Figma 446:37327 with the rename dialog
 * 446:37470 and the archive confirmation 446:37514), and the staff portal preview's client-only
 * reads.
 */
const label = (key: string) => translate('en-US', key as MessageKey);
const NOW = Date.parse('2026-10-31T12:00:00Z');

const ATLAS = {
  id: 'co-atlas',
  name: 'Atlas Hospitality',
  createdAt: '2026-07-04T00:00:00Z',
  updatedAt: '2026-10-01T00:00:00.000Z',
  archivedAt: null,
};

interface Call {
  method: string;
  path: string;
  body: unknown;
}

function mount() {
  const calls: Call[] = [];
  const reply = (body: unknown, status = 200) =>
    Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      }),
    );
  const fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input.toString());
    const method = (init?.method ?? 'GET').toUpperCase();
    const path = url.pathname.replace('/v1/organizations/northstar', '');
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    calls.push({ method, path: `${path}${url.search}`, body });

    if (method === 'GET' && path === '/client-organizations/co-atlas') return reply(ATLAS);
    if (method === 'GET' && path === '/client-memberships') {
      return reply({
        clientMemberships: [
          {
            id: 'm1',
            clientOrganizationId: 'co-atlas',
            userId: 'u1',
            role: 'client_admin',
            status: 'active',
            expiresAt: null,
            createdAt: '',
            updatedAt: '',
            displayName: 'Salma Riad',
            email: 'salma@atlas.example',
          },
        ],
      });
    }
    if (method === 'GET' && path === '/client-organizations/co-atlas/invitations') {
      return reply({
        invitations: [
          {
            id: 'inv-1',
            email: 'nadia@atlas.example',
            role: 'client_reviewer',
            clientOrganizationId: 'co-atlas',
            status: 'pending',
            expiresAt: '2026-11-30T00:00:00Z',
            createdAt: '2026-10-29T09:00:00Z',
          },
        ],
      });
    }
    if (method === 'PATCH') return reply({ ...ATLAS, name: (body as { name: string }).name });
    if (method === 'DELETE') return reply({ ...ATLAS, archivedAt: '2026-10-31T12:00:00Z' });
    return reply({});
  }) as typeof globalThis.fetch;

  const client = new ApiClient({
    baseUrl: 'https://api.example.test',
    csrfCookieName: 'tm_session_csrf',
    fetch,
    readCsrfToken: () => undefined,
    newCorrelationId: () => 'c',
  });
  const query = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={query}>
      <ClientCompanyScreen
        organizationSlug="northstar"
        organizationName="Northstar Studio"
        clientOrganizationId="co-atlas"
        client={client}
        now={() => NOW}
      />
    </QueryClientProvider>,
  );
  return calls;
}

describe('ClientCompanyScreen', () => {
  it('shows the company, its people by name and its pending invitations', async () => {
    const calls = mount();
    const people = await screen.findByRole('list', { name: label('Clients.peopleTitle') });
    expect(within(people).getByText('Salma Riad')).toBeTruthy();
    expect(within(people).getByText(/salma@atlas\.example/)).toBeTruthy();
    const invitations = await screen.findByRole('list', {
      name: label('Clients.invitationsTitle'),
    });
    expect(within(invitations).getByText('nadia@atlas.example')).toBeTruthy();
    expect(calls.some((call) => call.path.includes('withPeople=true'))).toBe(true);
  });

  it('renames the company with its updatedAt guard', async () => {
    const calls = mount();
    fireEvent.click(await screen.findByRole('button', { name: label('Clients.rename') }));
    const dialog = await screen.findByRole('dialog', { name: label('Clients.renameTitle') });
    fireEvent.change(
      within(dialog).getByLabelText(label('Clients.companyNameLabel'), { exact: false }),
      { target: { value: 'Atlas Hotels' } },
    );
    fireEvent.click(within(dialog).getByRole('button', { name: label('Clients.saveName') }));
    await waitFor(() => expect(calls.some((call) => call.method === 'PATCH')).toBe(true));
    expect(calls.find((call) => call.method === 'PATCH')!.body).toEqual({
      name: 'Atlas Hotels',
      updatedAt: ATLAS.updatedAt,
    });
  });

  it('archives the company after a confirmation', async () => {
    const calls = mount();
    fireEvent.click(await screen.findByRole('button', { name: label('Clients.archiveClient') }));
    const dialog = await screen.findByRole('alertdialog');
    expect(calls.some((call) => call.method === 'DELETE')).toBe(false);
    fireEvent.click(within(dialog).getByRole('button', { name: label('Clients.archiveClient') }));
    await waitFor(() =>
      expect(
        calls.some(
          (call) => call.method === 'DELETE' && call.path === '/client-organizations/co-atlas',
        ),
      ).toBe(true),
    );
  });
});

describe('clientOnlyRead (staff portal preview)', () => {
  const staff = [{ slug: 'northstar', audience: 'internal', clientOrganizationName: null }];
  const member = [{ slug: 'northstar', audience: 'client', clientOrganizationName: 'Atlas' }];
  const forbidden = () => new ApiRequestError(403, 'forbidden', 'nope', 'c');

  it('answers the empty value for staff without calling the client-only route', async () => {
    const query = new QueryClient();
    query.setQueryData(['shell', 'organizations'], staff);
    let called = false;
    const result = await clientOnlyRead(query, 'northstar', [], async () => {
      called = true;
      return ['x'];
    });
    expect(result).toEqual([]);
    expect(called).toBe(false);
  });

  it('turns a 403 into the empty value once the session shows staff', async () => {
    const query = new QueryClient();
    query.setQueryData(['shell', 'organizations'], undefined);
    const result = await clientOnlyRead(query, 'northstar', [] as string[], async () => {
      query.setQueryData(['shell', 'organizations'], staff);
      throw forbidden();
    });
    expect(result).toEqual([]);
  });

  it('keeps a client’s 403 an error', async () => {
    const query = new QueryClient();
    query.setQueryData(['shell', 'organizations'], member);
    await expect(
      clientOnlyRead(query, 'northstar', [], async () => {
        throw forbidden();
      }),
    ).rejects.toBeInstanceOf(ApiRequestError);
  });
});
