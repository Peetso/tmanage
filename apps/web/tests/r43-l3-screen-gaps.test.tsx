import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ReactElement } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ApiClient } from '../src/lib/api/client';
import { AdminAuditScreen } from '../src/components/screens/AdminAuditScreen';
import { InboundMailSettingsScreen } from '../src/components/screens/InboundMailSettingsScreen';
import { PreferencesNav } from '../src/components/screens/PreferencesScreen';
import { linkedItemIdFrom } from '../src/components/screens/WorkItemDependenciesScreen';
import { WorkItemLinksScreen } from '../src/components/screens/WorkItemLinksScreen';
import { DisclosurePage } from '../src/components/website/pages/disclosure/DisclosurePage';

/**
 * R43 L3 — four small screen gaps (Figma section 575:32611): the public disclosure page (56-17),
 * the audit log's integrity check (56-11), the work item links page (56-07), inbound mail settings
 * (54-12) and the settings-nav link to sign-in security.
 */

interface Call {
  method: string;
  url: string;
  body: unknown;
}

type Route = (call: Call) => { status: number; body?: unknown };

function mount(ui: (client: ApiClient) => ReactElement, route: Route) {
  const calls: Call[] = [];
  const client = new ApiClient({
    baseUrl: 'https://api.example.test',
    csrfCookieName: 'tm_session_csrf',
    fetch: ((input: RequestInfo | URL, init?: RequestInit) => {
      const call = {
        method: init?.method ?? 'GET',
        url: String(input),
        body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
      };
      calls.push(call);
      const { status, body } = route(call);
      return Promise.resolve(
        new Response(body === undefined ? null : JSON.stringify(body), {
          status,
          headers: { 'content-type': 'application/json' },
        }),
      );
    }) as typeof globalThis.fetch,
    readCsrfToken: () => undefined,
    newCorrelationId: () => 'c',
  });
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      {ui(client)}
    </QueryClientProvider>,
  );
  return calls;
}

const problem = (status: number, code: string) => ({
  status,
  body: { error: { code, message: 'Refused', correlationId: 'c' } },
});

describe('56-17 security disclosure page', () => {
  it('offers a mail link to the real support mailbox with the four policy parts', () => {
    render(<DisclosurePage />);
    const mail = screen.getByRole('link', { name: 'Email the security team' });
    expect(mail.getAttribute('href')).toBe('mailto:tm-support@peetrix.com?subject=Security');
    for (const heading of [
      'How to report',
      'What is in scope',
      'Safe harbour',
      'How fast we answer',
    ]) {
      expect(screen.getByRole('heading', { name: heading })).toBeTruthy();
    }
    expect(screen.getByText('Within 3 working days')).toBeTruthy();
  });

  it('publishes a security.txt that points at the policy and has not expired', () => {
    const text = readFileSync(join(process.cwd(), 'public', '.well-known', 'security.txt'), 'utf8');
    expect(text).toContain('Contact: mailto:tm-support@peetrix.com');
    expect(text).toContain('Policy: https://tmanage.peetrix.com/security/disclosure');
    const expires = /^Expires: (.+)$/m.exec(text)?.[1];
    expect(new Date(expires!).getTime()).toBeGreaterThan(Date.now());
  });
});

describe('56-11 audit log integrity check', () => {
  const auditRoute =
    (integrity: { status: number; body?: unknown }): Route =>
    (call) => {
      if (call.url.includes('/admin/audit/integrity')) return integrity;
      if (call.url.includes('/members')) return { status: 200, body: { members: [] } };
      return { status: 200, body: { events: [] } };
    };
  const mountAudit = (integrity: { status: number; body?: unknown }) =>
    mount(
      (client) => (
        <AdminAuditScreen
          organizationSlug="northstar"
          organizationName="Northstar"
          client={client}
        />
      ),
      auditRoute(integrity),
    );
  const report = (over: object) => ({
    status: 'intact',
    complete: true,
    checkedEvents: 1248,
    legacyEvents: 0,
    unchainedEvents: 0,
    head: null,
    chainStartedAt: null,
    firstBreak: null,
    ...over,
  });

  it('checks only when asked, then says the log is intact', async () => {
    const calls = mountAudit({ status: 200, body: report({}) });
    const button = await screen.findByRole('button', { name: 'Check integrity' });
    expect(calls.some((c) => c.url.includes('/integrity'))).toBe(false);
    fireEvent.click(button);
    expect(await screen.findByText('Audit log intact')).toBeTruthy();
    expect(screen.getByText(/1,248 entries checked/)).toBeTruthy();
  });

  it('names the first broken entry by its position', async () => {
    mountAudit({
      status: 200,
      body: report({
        status: 'broken',
        firstBreak: { reason: 'row_hash_mismatch', eventId: 'e-1031', chainSeq: 1031 },
      }),
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Check integrity' }));
    expect(await screen.findByText('Audit log changed')).toBeTruthy();
    expect(screen.getByText(/first changed entry is #1,031/)).toBeTruthy();
  });

  it('explains a refusal to someone without the whole log', async () => {
    mountAudit(problem(403, 'forbidden'));
    fireEvent.click(await screen.findByRole('button', { name: 'Check integrity' }));
    expect(await screen.findByText(/Only owners and admins/)).toBeTruthy();
  });
});

describe('56-07 work item links', () => {
  it('reduces a pasted item link to its id', () => {
    expect(linkedItemIdFrom(' https://tmanage.peetrix.com/acme/work/wi-42?tab=1 ')).toBe('wi-42');
    expect(linkedItemIdFrom('/acme/work/wi-7/activity')).toBe('wi-7');
    expect(linkedItemIdFrom('wi-9')).toBe('wi-9');
  });

  it('lists links with the other item as a link and adds one by pasted address', async () => {
    const calls = mount(
      (client) => (
        <WorkItemLinksScreen
          organizationSlug="acme"
          organizationName="Acme"
          workItemId="wi-1"
          client={client}
        />
      ),
      (call) =>
        call.method === 'POST'
          ? { status: 201, body: {} }
          : {
              status: 200,
              body: {
                links: [
                  {
                    id: 'l1',
                    fromWorkItemId: 'wi-1',
                    toWorkItemId: 'wi-2',
                    toWorkItemTitle: 'Publish homepage copy',
                    toWorkItemState: 'in_progress',
                    linkType: 'blocks',
                    createdAt: '2026-11-08T09:00:00Z',
                  },
                ],
              },
            },
    );
    const list = await screen.findByRole('list', { name: 'Work item links' });
    expect(within(list).getByText('Blocks')).toBeTruthy();
    expect(
      within(list).getByRole('link', { name: 'Publish homepage copy' }).getAttribute('href'),
    ).toBe('/acme/work/wi-2');
    expect(screen.getByRole('link', { name: 'Links' }).getAttribute('aria-current')).toBe('page');

    fireEvent.change(screen.getByLabelText('Relationship'), { target: { value: 'relates' } });
    fireEvent.change(screen.getByLabelText(/Linked item/), {
      target: { value: 'https://tmanage.peetrix.com/acme/work/wi-3' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Add link' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'POST')).toBe(true));
    expect(calls.find((c) => c.method === 'POST')!.body).toEqual({
      toWorkItemId: 'wi-3',
      linkType: 'relates',
    });
  });
});

describe('54-12 inbound mail settings', () => {
  const ADDRESS = {
    id: 'a1',
    address: 'inbox-7k2q9@in.tmanage.peetrix.com',
    status: 'active',
    defaultProjectId: 'p1',
    createdAt: '2026-11-01T00:00:00Z',
    rotatedAt: null,
  };
  const LOG = {
    entries: [
      {
        id: 'm1',
        fromEmail: 'maya@client.example',
        subject: 'Brief for the spring campaign',
        authResult: 'pass',
        outcome: 'client_request',
        outcomeReason: null,
        linkedObjectType: null,
        linkedObjectId: null,
        droppedAttachments: 0,
        trustedAt: null,
        receivedAt: '2026-11-08T08:00:00Z',
        attachments: [],
      },
      {
        id: 'm2',
        fromEmail: 'unknown@mail.example',
        subject: null,
        authResult: 'pass',
        outcome: 'held',
        outcomeReason: 'unknown_sender',
        linkedObjectType: null,
        linkedObjectId: null,
        droppedAttachments: 0,
        trustedAt: null,
        receivedAt: '2026-11-08T07:00:00Z',
        attachments: [],
      },
    ],
    nextCursor: null,
  };
  const mountInbound = (address: unknown) =>
    mount(
      (client) => (
        <InboundMailSettingsScreen
          organizationSlug="acme"
          organizationName="Acme"
          client={client}
        />
      ),
      (call) => {
        if (call.url.endsWith('/log')) return { status: 200, body: LOG };
        if (call.method === 'POST') return { status: 200, body: { ...ADDRESS, id: 'a2' } };
        return { status: 200, body: { address } };
      },
    );

  it('shows the address and copies it', async () => {
    const writeText = vi.fn(() => Promise.resolve());
    Object.assign(navigator, { clipboard: { writeText } });
    mountInbound(ADDRESS);
    expect(await screen.findByText(ADDRESS.address)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Copy' }));
    expect(await screen.findByRole('button', { name: 'Copied' })).toBeTruthy();
    expect(writeText).toHaveBeenCalledWith(ADDRESS.address);
  });

  it('asks before making a new address', async () => {
    const calls = mountInbound(ADDRESS);
    fireEvent.click(await screen.findByRole('button', { name: 'New address' }));
    expect(calls.some((c) => c.method === 'POST')).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Make a new address' }));
    await waitFor(() =>
      expect(calls.some((c) => c.method === 'POST' && c.url.endsWith('/address/rotate'))).toBe(
        true,
      ),
    );
  });

  it('lists recent mail with what became of it, never a raw code', async () => {
    mountInbound(ADDRESS);
    expect(await screen.findByText('Brief for the spring campaign')).toBeTruthy();
    expect(screen.getByText('Request created')).toBeTruthy();
    expect(screen.getByText('Waiting for review')).toBeTruthy();
    expect(screen.getByText('(no subject)')).toBeTruthy();
    expect(screen.queryByText('client_request')).toBeNull();
  });

  it('offers to create an address when there is none', async () => {
    const calls = mountInbound(null);
    fireEvent.click(await screen.findByRole('button', { name: 'Create address' }));
    await waitFor(() =>
      expect(calls.some((c) => c.method === 'POST' && c.url.endsWith('/address'))).toBe(true),
    );
  });
});

describe('settings nav', () => {
  it('links to sign-in security and marks it current there', () => {
    render(<PreferencesNav organizationSlug="acme" current="sign-in-security" />);
    const link = screen.getByRole('link', { name: 'Sign-in security' });
    expect(link.getAttribute('href')).toBe('/acme/settings/sign-in-security');
    expect(link.getAttribute('aria-current')).toBe('page');
  });
});
