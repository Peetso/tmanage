import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SignUpScreen } from '../src/components/screens/SignUpScreen';
import { PlatformOutreachCampaignScreen } from '../src/components/platform/settings/PlatformOutreachCampaignScreen';
import { PlatformOutreachScreen } from '../src/components/platform/settings/PlatformOutreachScreen';
import { ApiClient } from '../src/lib/api/client';
import { AuthBoundary } from '../src/lib/auth-boundary';
import type { PlatformMeView } from '../src/lib/api/platform-admin';
import type {
  OutreachCampaignDetailView,
  OutreachCampaignView,
  OutreachView,
} from '../src/lib/api/platform-outreach';
import { trialTokenFromQuery } from '../src/lib/api/trial-invites';

/**
 * LANE-Q — the personal trial link pre-fills sign-up (and never blocks it), and Platform admin ->
 * Settings -> Outreach imports a paused campaign and starts it only after a confirmation.
 */

afterEach(() => {
  cleanup();
  window.history.replaceState(null, '', '/');
});

interface Call {
  readonly path: string;
  readonly method: string;
  readonly body: unknown;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: () => undefined }) }));

function clientOver(handler: (call: Call) => Response) {
  const calls: Call[] = [];
  const client = new ApiClient({
    baseUrl: 'https://api.example.test',
    csrfCookieName: 'tm_session_csrf',
    fetch: ((input: RequestInfo | URL, init?: RequestInit) => {
      const call = {
        path: String(input).replace('https://api.example.test', ''),
        method: init?.method ?? 'GET',
        body: init?.body ? JSON.parse(String(init.body)) : null,
      };
      calls.push(call);
      return Promise.resolve(handler(call));
    }) as typeof globalThis.fetch,
    readCsrfToken: () => 'csrf',
    newCorrelationId: () => 'c',
  });
  return { client, calls };
}

const TOKEN =
  'v1.0199aa00-0000-7000-8000-0000000000aa.1767225600.abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ';

describe('LANE-Q trial link on /sign-up', () => {
  it('accepts only the token shape', () => {
    expect(trialTokenFromQuery(TOKEN)).toBe(TOKEN);
    expect(trialTokenFromQuery('lead@atlas.example')).toBeNull();
    expect(trialTokenFromQuery(null)).toBeNull();
  });

  it('pre-fills the address and workspace, and sends the token with the sign-up', async () => {
    window.history.replaceState(null, '', `/sign-up?trial=${TOKEN}&utm_source=campaign`);
    const user = userEvent.setup();
    const { client, calls } = clientOver((call) => {
      if (call.path.startsWith('/v1/public/trial-invites/')) {
        return json({ company: 'Atlas Studio', email: 'lead@atlas.example', language: 'en' });
      }
      if (call.method === 'POST') return json({ error: { code: 'conflict', message: 'x' } }, 409);
      return json({ available: true });
    });
    render(<SignUpScreen client={client} boundary={new AuthBoundary()} />);
    expect(await screen.findByText(/filled in from your invitation/u)).toBeInTheDocument();
    expect(screen.getByLabelText(/^Email/)).toHaveValue('lead@atlas.example');
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    expect(await screen.findByLabelText(/^Workspace name/)).toHaveValue('Atlas Studio');
    await user.type(screen.getByLabelText(/^Full name/), 'Lee Atlas');
    await user.type(screen.getByLabelText(/^Password/), 'violet-harbour-lantern-41');
    await user.click(screen.getByRole('button', { name: 'Create my workspace' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'POST')).toBe(true));
    expect(calls.find((c) => c.method === 'POST')?.body).toMatchObject({
      email: 'lead@atlas.example',
      organizationName: 'Atlas Studio',
      trialToken: TOKEN,
    });
    // The token rides in the path of one lookup, never with a person's data in the URL.
    expect(calls.filter((c) => c.path.includes('lead@'))).toEqual([]);
  });

  it('says the link cannot be used and leaves the form empty and open', async () => {
    window.history.replaceState(null, '', `/sign-up?trial=${TOKEN}`);
    const { client } = clientOver((call) =>
      call.path.startsWith('/v1/public/trial-invites/')
        ? json({ error: { code: 'not_found', message: 'x' } }, 404)
        : json({ available: true }),
    );
    render(<SignUpScreen client={client} boundary={new AuthBoundary()} />);
    expect(await screen.findByText(/expired or was already used/u)).toBeInTheDocument();
    expect(screen.getByLabelText(/^Email/)).toHaveValue('');
  });
});

const ME: PlatformMeView = {
  email: 'peter@peetrix.com',
  displayName: 'Peter',
  mfaEnabled: true,
  stepUpNeedsAuthenticatorCode: true,
  stepUpExpiresAt: new Date(Date.now() + 9 * 60_000).toISOString(),
  stepUpMinutes: 15,
  source: 'env',
  preset: 'super_admin',
  permissions: ['platform.settings.edit'],
  supportSessions: [],
};

const EMPTY: OutreachView = { campaigns: [], recipients: [], postalAddressSet: true };
const PAUSED: OutreachView = {
  campaigns: [
    {
      id: 'c-1',
      name: 'Decision makers 2026-11',
      status: 'paused',
      languages: ['en'],
      senderPool: 'auto',
      dailyCap: 20,
      warmup: true,
      followupEnabled: false,
      followupDays: 4,
      archivedAt: null,
      firstStartedAt: null,
      createdAt: '2026-11-20T10:00:00Z',
      counts: { queued: 2 },
      trialsRedeemed: 0,
      walkthroughs: 0,
      followupsSent: 0,
      replied: 0,
      optedOut: 0,
    },
  ],
  recipients: [
    {
      id: 'r-1',
      company: 'Eta Studio',
      personName: 'Eeva Koski',
      firstName: 'Eeva',
      country: 'FI',
      language: 'en',
      sender: 'emma@tmanageapp.com',
      senderPersonId: 'p-emma',
      status: 'queued',
      sentAt: null,
      lastError: null,
      trialRedeemedAt: null,
      walkthroughAt: null,
      repliedAt: null,
      followupStatus: null,
      followupSentAt: null,
      optedOut: false,
    },
  ],
  postalAddressSet: true,
};

function mountOutreach() {
  let state: OutreachView = EMPTY;
  const { client, calls } = clientOver((call) => {
    if (call.path === '/v1/platform/me') return json(ME);
    if (call.path === '/v1/platform/outreach/import') {
      state = PAUSED;
      return json({ ...PAUSED, imported: 1, rows: 3, excluded: { consent_country: 2 } }, 201);
    }
    if (call.path === '/v1/platform/outreach/campaigns/c-1/start') {
      const first = PAUSED.campaigns[0] as OutreachView['campaigns'][number];
      state = { ...PAUSED, campaigns: [{ ...first, status: 'running' }] };
      return json(state);
    }
    if (call.path === '/v1/platform/outreach') return json(state);
    return json({ error: { code: 'not_found', message: 'x' } }, 404);
  });
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <PlatformOutreachScreen client={client} />
    </QueryClientProvider>,
  );
  return calls;
}

describe('LANE-Q Platform admin -> Outreach', () => {
  it('imports a list as a paused campaign and shows who was left out', async () => {
    const calls = mountOutreach();
    expect(await screen.findByText('No campaign yet. Import a list to create one.')).toBeTruthy();
    const file = new File(['company,country\nEta,Finland\n'], 'decision-makers.csv', {
      type: 'text/csv',
    });
    fireEvent.change(screen.getByLabelText('CSV file'), { target: { files: [file] } });
    const button = screen.getByRole('button', { name: 'Import as a paused campaign' });
    await waitFor(() => expect(button).toHaveProperty('disabled', false));
    fireEvent.click(button);
    expect(await screen.findByText('1 of 3 rows imported. Nothing has been sent.')).toBeTruthy();
    expect(screen.getByText(/Country needs prior consent \(DE, DK, NO\)/u)).toBeTruthy();
    expect(calls.find((c) => c.path === '/v1/platform/outreach/import')?.body).toEqual({
      csv: 'company,country\nEta,Finland\n',
    });
    expect(await screen.findByText('Paused')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Decision makers 2026-11' })).toBeTruthy();
  });

  it('starts a campaign only after the confirmation', async () => {
    const calls = mountOutreach();
    await screen.findByText('No campaign yet. Import a list to create one.');
    fireEvent.change(screen.getByLabelText('CSV file'), {
      target: { files: [new File(['x'], 'a.csv', { type: 'text/csv' })] },
    });
    const importButton = screen.getByRole('button', { name: 'Import as a paused campaign' });
    await waitFor(() => expect(importButton).toHaveProperty('disabled', false));
    fireEvent.click(importButton);
    const row = (await screen.findByText('Decision makers 2026-11')).closest('tr') as HTMLElement;
    fireEvent.click(within(row).getByRole('button', { name: 'Start' }));
    expect(calls.some((c) => c.path.endsWith('/start'))).toBe(false);
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Start' }));
    expect(await screen.findByText('Running')).toBeTruthy();
    expect(calls.filter((c) => c.path.endsWith('/start'))).toHaveLength(1);
  });
});

const STARTED: OutreachCampaignView = {
  ...(PAUSED.campaigns[0] as OutreachCampaignView),
  status: 'running',
  firstStartedAt: '2026-11-21T09:00:00Z',
};
const DETAIL: OutreachCampaignDetailView = {
  campaign: STARTED,
  senders: [
    { id: 'p-emma', address: 'emma@tmanageapp.com', name: 'Emma', side: 'en', chosen: false },
  ],
  emails: {
    intro: {
      en: { subject: 'Client approvals', body: 'Hi {first name},', version: 1, savedAt: null },
    },
    followup: {},
  },
  versions: [
    {
      kind: 'intro',
      version: 1,
      languages: ['en'],
      createdAt: '2026-11-21T09:00:00Z',
      byYou: true,
    },
  ],
  postalAddressSet: true,
  placeholders: [
    '{first name}',
    '{company}',
    '{sender name}',
    '{trial link}',
    '{walkthrough link}',
  ],
  languages: ['en', 'ar'],
};

function mountCampaign() {
  const { client, calls } = clientOver((call) => {
    if (call.path === '/v1/platform/me') return json(ME);
    if (call.path === '/v1/platform/outreach/campaigns/c-1') return json(DETAIL);
    if (call.path === '/v1/platform/outreach/campaigns/c-1/recipients') {
      return json({ campaign: STARTED, recipients: PAUSED.recipients, postalAddressSet: true });
    }
    if (call.path === '/v1/platform/outreach/campaigns/c-1/preview') {
      return json({
        from: 'Emma from TManage <emma@tmanageapp.com>',
        to: 's•••@example.com',
        subject: String((call.body as { subject?: string } | null)?.subject ?? ''),
        text: 'Hi Sam,\n\nUnsubscribe: https://tmanageapp.com/u',
        recipientId: null,
        problems: [],
      });
    }
    if (call.path === '/v1/platform/outreach/campaigns/c-1/emails/intro') return json(DETAIL);
    if (call.path === '/v1/platform/outreach/campaigns/c-1/test-send') {
      return json({ sent: true, to: 'peter@peetrix.com' });
    }
    return json({ error: { code: 'not_found', message: 'x' } }, 404);
  });
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <PlatformOutreachCampaignScreen client={client} campaignId="c-1" />
    </QueryClientProvider>,
  );
  return calls;
}

describe('OUTREACH MANAGER one campaign', () => {
  it('asks before changing a started campaign, then saves the next version', async () => {
    const calls = mountCampaign();
    fireEvent.click(await screen.findByRole('tab', { name: 'E-mail' }));
    const subject = await screen.findByLabelText('Subject');
    fireEvent.change(subject, { target: { value: 'Approvals at {company}' } });
    expect(await screen.findByText('Not saved')).toBeTruthy();
    await waitFor(() => expect(calls.some((c) => c.path.endsWith('/preview'))).toBe(true));
    fireEvent.click(screen.getByRole('button', { name: 'Save as a new version' }));
    expect(calls.some((c) => c.method === 'PUT')).toBe(false);
    fireEvent.click(
      within(screen.getByRole('dialog')).getByRole('button', {
        name: 'Save and use for the next e-mails',
      }),
    );
    await waitFor(() => expect(calls.some((c) => c.method === 'PUT')).toBe(true));
    expect(calls.find((c) => c.method === 'PUT')?.body).toEqual({
      texts: { en: { subject: 'Approvals at {company}', body: 'Hi {first name},' } },
      confirmStarted: true,
    });
  });

  it('sends the test to me only and shows the address it went to', async () => {
    const calls = mountCampaign();
    fireEvent.click(await screen.findByRole('tab', { name: 'E-mail' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Send a test to me' }));
    expect(await screen.findByText('Test sent to peter@peetrix.com.')).toBeTruthy();
    expect(calls.find((c) => c.path.endsWith('/test-send'))?.body).toMatchObject({
      kind: 'intro',
      language: 'en',
    });
  });
});
