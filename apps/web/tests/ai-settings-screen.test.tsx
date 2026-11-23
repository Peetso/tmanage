import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ApiClient } from '../src/lib/api/client';
import type { AiSettingsView } from '../src/lib/api/ai-settings';
import { AiSettingsScreen } from '../src/components/ai-admin/AiSettingsScreen';
import { patchOf, draftOf, withScope } from '../src/components/ai-admin/ai-settings-model';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn(), refresh: vi.fn() }),
  usePathname: () => '/northstar/admin/ai',
  useSearchParams: () => new URLSearchParams(),
  useParams: () => ({}),
}));

/** Plan 62-17 — Control Center › AI › Settings (Figma G1 v2 786:48751). */

const ORG = 'https://api.example.test/v1/organizations/northstar';
const SETTINGS = `${ORG}/copilot/settings`;
const KARIM = '44444444-4444-4444-8444-444444444444';
const LINA = '55555555-5555-4555-8555-555555555555';

const VIEW: AiSettingsView = {
  aiEnabled: true,
  writeScope: 'read_write',
  runAtOnce: false,
  fileReading: true,
  memberSharePercent: 50,
  conversationRetentionDays: 30,
  blockedMembers: [
    { membershipId: KARIM, displayName: 'Karim Aziz', blockedAt: '2026-11-02T09:00:00Z' },
  ],
  credits: {
    workspaceCredits: 2000,
    memberCredits: 1000,
    shareChoices: [
      { percent: 25, memberCredits: 500 },
      { percent: 50, memberCredits: 1000 },
      { percent: 75, memberCredits: 1500 },
      { percent: 100, memberCredits: 2000 },
    ],
  },
  providers: ['anthropic'],
  updatedAt: '2026-11-20T09:00:00Z',
  readiness: 'ready',
};

const GRANTS = `${ORG}/oauth/grants`;
const MY_CLAUDE = {
  status: 200,
  body: {
    owner: true,
    viewerName: 'Lina',
    aiAccessEnabled: true,
    apps: [
      {
        id: 'g1',
        clientName: 'Claude Desktop',
        verified: true,
        scopes: [],
        memberName: 'Lina',
        mine: true,
        connectedAt: '2026-11-20T09:00:00Z',
        lastUsedAt: null,
      },
    ],
  },
};

/** Both direction cards, by their headings (AI-TWO-WAYS). */
async function bothCards() {
  await waitFor(() => expect(screen.queryByText('Loading the AI settings…')).toBeNull());
  const company = await screen.findByRole('region', { name: 'TManage AI' });
  const own = screen.getByRole('region', { name: 'Your own AI' });
  return { company, own };
}

type Reply = { status: number; body: unknown };

function mount(routes: Record<string, Reply | ((body: unknown) => Reply)>) {
  const calls: { key: string; body: unknown }[] = [];
  const api = new ApiClient({
    baseUrl: 'https://api.example.test',
    csrfCookieName: 'tm_session_csrf',
    fetch: ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input).split('?')[0]!;
      const key = `${init?.method ?? 'GET'} ${url}`;
      const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined;
      calls.push({ key, body });
      const route = routes[key];
      const reply =
        route === undefined
          ? { status: 404, body: { error: { code: 'not_found', message: 'x' } } }
          : typeof route === 'function'
            ? route(body)
            : route;
      return Promise.resolve(
        new Response(JSON.stringify(reply.body), {
          status: reply.status,
          headers: { 'content-type': 'application/json' },
        }),
      );
    }) as typeof globalThis.fetch,
    readCsrfToken: () => 'csrf',
    newCorrelationId: () => 'c',
  });
  const queries = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  queries.setQueryData(
    ['shell', 'organizations'],
    [
      {
        id: 'o',
        slug: 'northstar',
        name: 'Northstar',
        audience: 'internal',
        role: 'owner',
        clientOrganizationName: null,
      },
    ],
  );
  render(
    <QueryClientProvider client={queries}>
      <AiSettingsScreen organizationSlug="northstar" organizationName="Northstar" client={api} />
    </QueryClientProvider>,
  );
  return { calls, writes: () => calls.filter((call) => !call.key.startsWith('GET')) };
}

describe('AI settings model', () => {
  it('sends only what changed, and answers-only turns quick changes off', () => {
    const draft = { ...withScope({ ...draftOf(VIEW), runAtOnce: true }, 'read'), retention: '60' };
    expect(patchOf(VIEW, draft)).toEqual({ writeScope: 'read', conversationRetentionDays: 60 });
    expect(patchOf(VIEW, { ...draftOf(VIEW), blocked: [] })).toEqual({
      allowMembershipIds: [KARIM],
    });
  });
});

describe('AiSettingsScreen (62-17)', () => {
  it('saves the changed fields and the new block, then says so (786:49916, 786:50694)', async () => {
    const { writes } = mount({
      [`GET ${SETTINGS}`]: { status: 200, body: VIEW },
      [`GET ${ORG}/people`]: {
        status: 200,
        body: {
          people: [
            {
              membershipId: LINA,
              displayName: 'Lina Haddad',
              roleName: 'Designer',
              userId: 'u',
              role: 'member',
              projectCount: 1,
              version: 1,
              lastActiveAt: null,
              teams: [],
              openCommitments: 0,
              overdueCommitments: 0,
              declared: null,
            },
          ],
          nextAfter: null,
        },
      },
      [`PATCH ${SETTINGS}`]: { status: 200, body: { ...VIEW, updatedAt: '2026-11-22T09:00:00Z' } },
    });
    const save = await screen.findByRole('button', { name: 'Save changes' });
    expect(save.hasAttribute('disabled')).toBe(true);
    fireEvent.change(screen.getByRole('combobox', { name: 'Share for each member' }), {
      target: { value: '25' },
    });
    expect(
      (screen.getByRole('option', { name: '25 % · 500 credits' }) as HTMLOptionElement).selected,
    ).toBe(true);
    expect(screen.getByText('You have unsaved changes.')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Block a member' }));
    const dialog = screen.getByRole('dialog');
    fireEvent.change(within(dialog).getByRole('searchbox', { name: 'Find a member' }), {
      target: { value: 'Li' },
    });
    fireEvent.click(await within(dialog).findByRole('button', { name: 'Block Lina Haddad' }));
    expect(screen.getByText('Blocked when you save')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0]!.body).toEqual({ memberSharePercent: 25, blockMembershipIds: [LINA] });
    expect(
      await screen.findByText('Changes saved. Members see them from their next question.'),
    ).toBeTruthy();
  });

  it('refuses a retention out of range before sending (786:51477)', async () => {
    const { writes } = mount({ [`GET ${SETTINGS}`]: { status: 200, body: VIEW } });
    const field = await screen.findByRole('textbox', { name: 'Delete conversations after (days)' });
    fireEvent.change(field, { target: { value: '400' } });
    expect(screen.getByText('Choose between 1 and 365 days.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(writes()).toHaveLength(0);
  });

  it('answers-only disables quick changes (787:49285)', async () => {
    mount({ [`GET ${SETTINGS}`]: { status: 200, body: { ...VIEW, runAtOnce: true } } });
    fireEvent.click(await screen.findByRole('radio', { name: 'Answer questions only' }));
    const quick = screen.getByRole('switch', {
      name: /Quick everyday changes/,
    }) as HTMLInputElement;
    expect(quick.disabled).toBe(true);
    expect(quick.checked).toBe(false);
    expect(screen.getByText('Needs “Answer and make changes”.')).toBeTruthy();
  });

  it('turns AI off only after the confirmation (787:53287)', async () => {
    const { writes } = mount({
      [`GET ${SETTINGS}`]: { status: 200, body: VIEW },
      [`PATCH ${SETTINGS}`]: { status: 200, body: { ...VIEW, aiEnabled: false } },
    });
    fireEvent.click(
      await screen.findByRole('switch', { name: 'TManage AI for everyone in this workspace' }),
    );
    const dialog = screen.getByRole('dialog', { name: 'Turn off TManage AI for everyone?' });
    expect(writes()).toHaveLength(0);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Turn off' }));
    await waitFor(() => expect(writes()[0]?.body).toEqual({ aiEnabled: false }));
    expect(await screen.findByText('TManage AI is off. Members no longer see it.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Save changes' })).toBeNull();
  });

  it('tells a workspace off the test list that AI is not available yet', async () => {
    mount({});
    expect(
      await screen.findByText(/TManage AI is not available for your company yet/),
    ).toBeTruthy();
  });
});

describe('AiSettingsScreen: both directions in every state (AI-TWO-WAYS)', () => {
  it('loaded: the company switch beside your own AI, connected (770:44997)', async () => {
    mount({ [`GET ${SETTINGS}`]: { status: 200, body: VIEW }, [`GET ${GRANTS}`]: MY_CLAUDE });
    const { company, own } = await bothCards();
    expect((within(company).getByRole('switch') as HTMLInputElement).checked).toBe(true);
    expect(await within(own).findByText('Connected')).toBeTruthy();
    expect(within(own).getByRole('link', { name: 'Manage connection' }).getAttribute('href')).toBe(
      '/northstar/settings/connected-apps',
    );
  });

  it('G1 order: Your own AI first, then TManage AI; testing badge and lead (770:44997)', async () => {
    mount({ [`GET ${SETTINGS}`]: { status: 200, body: VIEW }, [`GET ${GRANTS}`]: MY_CLAUDE });
    const { company, own } = await bothCards();
    expect(own.compareDocumentPosition(company) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByText('Testing')).toBeTruthy();
    expect(screen.getByText(/Your workspace is in the test group\./)).toBeTruthy();
    expect(within(company).getByRole('link', { name: 'See usage' }).getAttribute('href')).toBe(
      '/northstar/admin/ai/usage',
    );
  });

  it('404 (not on the test list): the company card stays, switch off and disabled, with why', async () => {
    mount({ [`GET ${GRANTS}`]: MY_CLAUDE });
    const { company, own } = await bothCards();
    const toggle = (await within(company).findByRole('switch')) as HTMLInputElement;
    expect([toggle.checked, toggle.disabled]).toEqual([false, true]);
    expect(within(company).getByText(/not available for your company yet/)).toBeTruthy();
    expect(await within(own).findByText('Connected')).toBeTruthy();
  });

  it('403 (not the owner): read only, says who can change it; own AI still offered', async () => {
    mount({
      [`GET ${SETTINGS}`]: { status: 403, body: { error: { code: 'forbidden', message: 'x' } } },
    });
    const { company, own } = await bothCards();
    expect(
      await within(company).findByText(/Only the company owner can change the TManage AI/),
    ).toBeTruthy();
    expect(within(company).queryByRole('switch')).toBeNull();
    expect(within(own).queryByText('Connected')).toBeNull();
    expect(
      (await within(own).findByRole('link', { name: 'Connect your AI' })).getAttribute('href'),
    ).toBe('/northstar/settings/ai-assistant');
  });

  it('could not load: the error and Try again sit in the company card; the read is retried', async () => {
    let reads = 0;
    mount({
      [`GET ${SETTINGS}`]: () => {
        reads += 1;
        return reads === 1
          ? { status: 500, body: { error: { code: 'internal_error', message: 'x' } } }
          : { status: 200, body: VIEW };
      },
      [`GET ${GRANTS}`]: MY_CLAUDE,
    });
    const { company, own } = await bothCards();
    expect(await within(company).findByText('The AI settings could not be loaded')).toBeTruthy();
    expect(await within(own).findByText('Connected')).toBeTruthy();
    fireEvent.click(within(company).getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('button', { name: 'Save changes' })).toBeTruthy();
    expect(reads).toBe(2);
  });

  it('on, but no AI key yet / the module off: the owner reads it in the card before anyone asks', async () => {
    mount({ [`GET ${SETTINGS}`]: { status: 200, body: { ...VIEW, readiness: 'no_key' } } });
    const { company } = await bothCards();
    expect(await within(company).findByText(/no AI key is set for test workspaces/)).toBeTruthy();
  });

  it('the module off links to Modules', async () => {
    mount({ [`GET ${SETTINGS}`]: { status: 200, body: { ...VIEW, readiness: 'flag_off' } } });
    const { company } = await bothCards();
    const link = await within(company).findByRole('link', { name: 'Turn it on in Modules' });
    expect(link.getAttribute('href')).toBe('/northstar/admin/feature-flags');
  });
});
