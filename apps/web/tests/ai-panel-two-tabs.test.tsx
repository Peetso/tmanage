import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { ApiClient } from '../src/lib/api/client';
import type { AiApprovalView } from '../src/lib/api/ai-approvals';
import type { AiActivityItem, AiPanelApp, AiPanelView } from '../src/lib/api/ai-panel';
import { AiPanel } from '../src/components/ai-panel/AiPanel';
import { AiApproveScreen } from '../src/components/screens/AiApproveScreen';
import {
  activityKind,
  defaultTab,
  groupByDay,
  isLive,
  panelLayout,
  tmanageAiOff,
} from '../src/components/ai-panel/ai-panel-model';
import { DictationLanguagePicker } from '../src/components/ai-chat/DictationLanguagePicker';
import {
  DICTATION_LANGUAGES,
  appLanguageTag,
  dictationBlock,
  filterLanguages,
  isDesktopApp,
  isDictationTag,
} from '../src/components/ai-chat/dictation-language';
import { DICTATION_LANGUAGE_TAGS } from '@tmanage/domain';
import {
  toDisplayPreferencesUpdate,
  withDictationLanguage,
} from '../src/lib/api/display-preferences';
import type { DisplayPreferencesView } from '../src/lib/api/display-preferences';
import { expectNoAxeViolations } from './axe';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn(), refresh: vi.fn() }),
  usePathname: () => '/',
  useSearchParams: () => new URLSearchParams(),
  useParams: () => ({}),
}));

/**
 * The two-tab AI panel (Figma 851:906) and the dictation language picker (878:976): the pure rules
 * first, then one test per state the design draws.
 */

const BASE = 'https://api.example.test/v1/organizations/northstar';
const NOW = new Date('2026-11-23T10:00:00Z');
const WRONG_AMOUNT = 'This doesn’t match the amount on the card.';

function panelView(overrides: Partial<AiPanelView> = {}): AiPanelView {
  return {
    tmanageAi: { inPlan: true, enabled: true, available: true, reason: null, canManage: true },
    ownAi: { enabled: true, reason: null, canManage: true },
    apps: [],
    pendingApprovals: 0,
    ...overrides,
  };
}

function app(overrides: Partial<AiPanelApp> = {}): AiPanelApp {
  return {
    grantId: 'g1',
    clientName: 'Claude',
    verified: true,
    app: 'claude',
    openUrl: 'https://claude.ai/new',
    connectedAt: '2026-11-02T09:00:00Z',
    lastUsedAt: '2026-11-23T09:50:00Z',
    ...overrides,
  };
}

function approval(overrides: Partial<AiApprovalView> = {}): AiApprovalView {
  return {
    id: 'a1',
    status: 'pending',
    clientName: 'Claude',
    memberName: 'Lina',
    memberEmail: 'lina@example.test',
    summary: {
      opId: 'work_items.update',
      title: 'Change a task',
      method: 'PATCH',
      destructive: false,
      notifies: false,
      subject: 'Homepage hero copy',
      fields: [{ name: 'Due date', value: 'Mon 23 Nov' }],
    },
    confirmation: 'none',
    amount: null,
    expiresAt: '2026-11-23T10:30:00Z',
    decidedAt: null,
    ...overrides,
  };
}

function activity(overrides: Partial<AiActivityItem> = {}): AiActivityItem {
  return {
    id: 'e1',
    at: '2026-11-23T09:40:00Z',
    verb: 'read',
    failed: false,
    clientName: 'Claude',
    app: 'claude',
    kind: 'work_item',
    count: null,
    itemId: 'w1',
    itemName: 'Homepage hero copy',
    projectId: 'p1',
    projectName: 'Website relaunch',
    ...overrides,
  } as AiActivityItem;
}

type Reply = { status: number; body: unknown };
type Route = Reply | ((body: unknown, headers: Headers) => Reply);

function client(routes: Record<string, Route>) {
  const calls: { key: string; body: unknown; headers: Headers }[] = [];
  const api = new ApiClient({
    baseUrl: 'https://api.example.test',
    csrfCookieName: 'tm_session_csrf',
    fetch: ((input: RequestInfo | URL, init?: RequestInit) => {
      const key = `${init?.method ?? 'GET'} ${String(input)}`;
      const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined;
      const headers = new Headers(init?.headers);
      calls.push({ key, body, headers });
      const route = routes[key];
      const reply: Reply =
        route === undefined
          ? { status: 404, body: { error: { code: 'not_found', message: 'x' } } }
          : typeof route === 'function'
            ? route(body, headers)
            : route;
      return Promise.resolve(
        new Response(reply.status === 204 ? null : JSON.stringify(reply.body), {
          status: reply.status,
          headers: { 'content-type': 'application/json' },
        }),
      );
    }) as typeof globalThis.fetch,
    readCsrfToken: () => undefined,
    newCorrelationId: () => 'c',
  });
  return { api, calls };
}

const PENDING = `GET ${BASE}/ai/approvals`;
const ACTIVITY = `GET ${BASE}/ai/activity`;

function mountPanel(
  view: AiPanelView,
  routes: Record<string, Route> = {},
  options: { layout?: 'tabs' | 'own-only'; tab?: 'tmanage' | 'own'; failed?: boolean } = {},
) {
  const { api, calls } = client({
    [PENDING]: { status: 200, body: { items: [] } },
    [ACTIVITY]: { status: 200, body: { items: [], nextCursor: null } },
    ...routes,
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
  const onClose = vi.fn();
  const result = render(
    <QueryClientProvider client={queries}>
      <AiPanel
        api={api}
        organizationSlug="northstar"
        layout={options.layout ?? 'tabs'}
        view={view}
        initialTab={options.tab ?? 'tmanage'}
        address="https://api.example.test/mcp"
        onClose={onClose}
        onRetry={() => {}}
        failed={options.failed ?? false}
        now={() => NOW}
      />
    </QueryClientProvider>,
  );
  return { ...result, calls, onClose };
}

describe('AI panel rules', () => {
  it('shows tabs only when both directions exist', () => {
    expect(panelLayout(panelView())).toBe('tabs');
    expect(
      panelLayout(
        panelView({ ownAi: { enabled: false, reason: 'workspace_off', canManage: true } }),
      ),
    ).toBe('tmanage-only');
    expect(
      panelLayout(
        panelView({
          tmanageAi: {
            inPlan: false,
            enabled: false,
            available: false,
            reason: 'not_on_test_list',
            canManage: true,
          },
        }),
      ),
    ).toBe('own-only');
    expect(
      panelLayout(
        panelView({
          tmanageAi: {
            inPlan: false,
            enabled: false,
            available: false,
            reason: 'flag_off',
            canManage: true,
          },
          ownAi: { enabled: false, reason: 'platform_off', canManage: false },
        }),
      ),
    ).toBe('none');
  });

  it('opens on TManage AI, on Your AI when TManage AI is off or from the approvals badge', () => {
    expect(defaultTab(panelView())).toBe('tmanage');
    const off = panelView({
      tmanageAi: {
        inPlan: true,
        enabled: false,
        available: false,
        reason: 'ai_off',
        canManage: true,
      },
    });
    expect(tmanageAiOff(off)).toBe(true);
    expect(defaultTab(off)).toBe('own');
    expect(defaultTab(panelView({ pendingApprovals: 2 }), true)).toBe('own');
    expect(defaultTab(panelView({ pendingApprovals: 0 }), true)).toBe('tmanage');
  });

  it('names known kinds, folds aliases, and reads any other kind as an item', () => {
    expect([
      activityKind('work_item'),
      activityKind('task'),
      activityKind('widget'),
      activityKind(null),
    ]).toEqual(['work_item', 'work_item', 'item', 'item']);
  });

  it('groups by day in order, and says Live only while reads arrive', () => {
    const days = groupByDay(
      [
        activity({ id: '1', at: '2026-11-23T09:00:00Z' }),
        activity({ id: '2', at: '2026-11-23T08:00:00Z' }),
        activity({ id: '3', at: '2026-11-22T08:00:00Z' }),
      ],
      'UTC',
    );
    expect(days.map((day) => [day.key, day.items.length])).toEqual([
      ['2026-11-23', 2],
      ['2026-11-22', 1],
    ]);
    expect([isLive(0, 1000), isLive(1000, 41_000), isLive(1000, 41_001)]).toEqual([
      false,
      true,
      false,
    ]);
  });
});

describe('Dictation language rules', () => {
  it('offers exactly the 17 languages of 878:976, each tag once', () => {
    const tags = DICTATION_LANGUAGES.map((language) => language.tag);
    expect(tags).toHaveLength(17);
    expect(new Set(tags).size).toBe(17);
    expect(tags).toContain('ar');
    expect(tags).toContain('ar-EG');
  });

  it('defaults to the app language', () => {
    expect([
      appLanguageTag('en'),
      appLanguageTag('ar'),
      appLanguageTag('fr'),
      appLanguageTag('en-GB'),
    ]).toEqual(['en-US', 'ar-EG', 'fr-FR', 'en-GB']);
  });

  it('finds a language by its English or Arabic name, without diacritics', () => {
    const names = new Map([
      ['ar-EG', ['Arabic (Egypt)', 'Arabic (Egypt)', 'العربية (مصر)']],
      ['fr-FR', ['French', 'French (France)', 'الفرنسية (فرنسا)']],
    ]);
    expect(filterLanguages('egy', names).map((language) => language.tag)).toEqual(['ar-EG']);
    expect(filterLanguages('مصر', names).map((language) => language.tag)).toEqual(['ar-EG']);
    expect(filterLanguages('الفرنسيّة', names).map((language) => language.tag)).toEqual(['fr-FR']);
    expect(filterLanguages('', names)).toHaveLength(17);
  });

  it('is blocked in the desktop app and where the browser has no speech recognition', () => {
    expect(dictationBlock(true, false)).toBeNull();
    expect(dictationBlock(false, false)).toBe('browser');
    expect(dictationBlock(true, true)).toBe('desktop-app');
    expect(isDesktopApp({ tmanageDesktop: {} })).toBe(true);
    expect(isDesktopApp({})).toBe(false);
  });

  it('offers exactly the domain list the API validates the preference against', () => {
    expect(DICTATION_LANGUAGES.map((language) => language.tag)).toEqual([
      ...DICTATION_LANGUAGE_TAGS,
    ]);
    expect(isDictationTag('ar-SA')).toBe(true);
    expect(isDictationTag('xx-YY')).toBe(false);
  });

  it('saves the choice as the dictationLanguage preference, never echoing a fetched one', () => {
    const current: DisplayPreferencesView = {
      theme: 'system',
      density: 'comfortable',
      locale: 'en-US',
      timezone: 'UTC',
      dateFormat: 'iso',
      numerals: 'latin',
      calendarDisplay: 'gregorian',
      weekStart: 'monday',
      dictationLanguage: 'en-GB',
      uiMode: 'simple',
      uiModeSource: 'org_default',
      uiModeLocked: false,
    };
    expect(withDictationLanguage(current, 'ar-SA')).toMatchObject({
      theme: 'system',
      dictationLanguage: 'ar-SA',
    });
    expect(toDisplayPreferencesUpdate(current)).not.toHaveProperty('dictationLanguage');
  });
});

function Picker({ blocked = null }: { blocked?: 'browser' | 'desktop-app' | null }) {
  const [value, setValue] = useState('en-US');
  return (
    <>
      <DictationLanguagePicker
        value={value}
        appTag="en-US"
        onChange={setValue}
        blocked={blocked}
        locked={false}
      />
      <output data-testid="chosen">{value}</output>
    </>
  );
}

describe('DictationLanguagePicker (878:976)', () => {
  it('opens a searchable menu, narrows it, and a click chooses and closes', async () => {
    render(<Picker />);
    const chip = screen.getByRole('button', { name: 'Dictation language: English (US)' });
    fireEvent.click(chip);
    const menu = screen.getByRole('dialog', { name: 'Dictation language' });
    expect(within(menu).getAllByRole('radio')).toHaveLength(17);
    expect(
      (within(menu).getByRole('radio', { name: /English \(US\)/ }) as HTMLInputElement).checked,
    ).toBe(true);
    await expectNoAxeViolations(menu);

    fireEvent.change(within(menu).getByRole('searchbox', { name: 'Search languages' }), {
      target: { value: 'saudi' },
    });
    const only = within(menu).getAllByRole('radio');
    expect(only).toHaveLength(1);
    fireEvent.click(only[0]!, { detail: 1 });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByTestId('chosen').textContent).toBe('ar-SA');
    expect(
      screen.getByRole('button', { name: 'Dictation language: Arabic (Saudi Arabia)' }),
    ).toBeTruthy();
  });

  it('says when nothing matches, and Escape closes without choosing', () => {
    render(<Picker />);
    fireEvent.click(screen.getByRole('button', { name: /Dictation language/ }));
    const menu = screen.getByRole('dialog');
    fireEvent.change(within(menu).getByRole('searchbox'), { target: { value: 'klingon' } });
    expect(within(menu).getByText('No language matches “klingon”.')).toBeTruthy();
    fireEvent.keyDown(menu, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByTestId('chosen').textContent).toBe('en-US');
  });

  it('is disabled with a reason in the desktop app and does not open', () => {
    render(<Picker blocked="desktop-app" />);
    const chip = screen.getByRole('button', { name: /Dictation language/ });
    expect(chip.getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(chip);
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

describe('AiPanel: the two tabs (851:906)', () => {
  it('tablist with two tabs, the waiting count on Your AI, arrow keys move between them', async () => {
    mountPanel(panelView({ apps: [app()], pendingApprovals: 2 }), {
      [PENDING]: { status: 200, body: { items: [approval(), approval({ id: 'a2' })] } },
    });
    const tabs = screen.getAllByRole('tab');
    expect(tabs.map((tab) => tab.textContent)).toEqual([
      'TManage AI',
      expect.stringContaining('Your AI'),
    ]);
    expect(tabs[0]!.getAttribute('aria-selected')).toBe('true');
    expect(await within(tabs[1]!).findByText('2 waiting for your approval')).toBeTruthy();
    fireEvent.keyDown(tabs[0]!, { key: 'ArrowRight' });
    expect(tabs[1]!.getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement).toBe(tabs[1]);
    fireEvent.keyDown(tabs[1]!, { key: 'Home' });
    expect(tabs[0]!.getAttribute('aria-selected')).toBe('true');
  });

  it('Your AI alone: no tabs, a plain title with its ⓘ', () => {
    mountPanel(panelView({ apps: [app()] }), {}, { layout: 'own-only' });
    expect(screen.queryByRole('tablist')).toBeNull();
    expect(screen.getByRole('heading', { level: 2, name: 'Your AI' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'About Your AI' })).toBeTruthy();
  });

  it('TManage AI off, owner: the not-on line, the way to turn it on, and Go to Your AI', () => {
    mountPanel(
      panelView({
        tmanageAi: {
          inPlan: true,
          enabled: false,
          available: false,
          reason: 'ai_off',
          canManage: true,
        },
        apps: [app()],
      }),
    );
    expect(screen.getAllByText('TManage AI is not on for this workspace').length).toBeGreaterThan(
      0,
    );
    expect(
      screen.getByRole('link', { name: 'Turn it on in Control Center' }).getAttribute('href'),
    ).toBe('/northstar/admin/ai');
    fireEvent.click(screen.getByRole('button', { name: 'Go to Your AI' }));
    expect(screen.getAllByRole('tab')[1]!.getAttribute('aria-selected')).toBe('true');
  });

  it('TManage AI off, member: says who turns it on, no link', () => {
    mountPanel(
      panelView({
        tmanageAi: {
          inPlan: true,
          enabled: false,
          available: false,
          reason: 'ai_off',
          canManage: false,
        },
      }),
    );
    expect(
      screen.getByText('Your workspace owner can turn it on in Control Center › AI.'),
    ).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'Turn it on in Control Center' })).toBeNull();
  });

  it('Escape closes the panel', () => {
    const { onClose } = mountPanel(panelView({ apps: [app()] }));
    fireEvent.keyDown(screen.getAllByRole('tab')[0]!, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe('Your AI tab (857:1014, states 858:906)', () => {
  it('order: Waiting first, then Activity, then Connected apps; no axe violations', async () => {
    const { container } = mountPanel(
      panelView({ apps: [app()], pendingApprovals: 1 }),
      {
        [PENDING]: { status: 200, body: { items: [approval()] } },
        [ACTIVITY]: { status: 200, body: { items: [activity()], nextCursor: null } },
      },
      { tab: 'own' },
    );
    const own = screen.getByRole('tabpanel', { name: /Your AI/ });
    await within(own).findByRole('heading', { name: 'Waiting for your approval' });
    await within(own).findAllByText('Homepage hero copy');
    const headings = within(own)
      .getAllByRole('heading', { level: 3 })
      .map((heading) => heading.textContent);
    expect(headings).toEqual(['Waiting for your approval', 'Activity', 'Connected apps']);
    await expectNoAxeViolations(container);
  });

  it('a plain request: Approve runs it once and the card says Approved', async () => {
    const { calls } = mountPanel(
      panelView({ apps: [app()], pendingApprovals: 1 }),
      {
        [PENDING]: { status: 200, body: { items: [approval()] } },
        [`POST ${BASE}/ai/approvals/a1/approve`]: {
          status: 200,
          body: approval({ status: 'approved', decidedAt: '2026-11-23T10:01:00Z' }),
        },
      },
      { tab: 'own' },
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Approve' }));
    expect(await screen.findByText('Approved')).toBeTruthy();
    expect(calls.filter((call) => call.key.startsWith('POST'))).toHaveLength(1);
  });

  it('a money request shows Review, never Approve; the review refuses a wrong amount, then sends amount and step-up', async () => {
    const money = approval({
      summary: {
        ...approval().summary,
        opId: 'expenses.approve',
        title: 'Approve an expense',
        subject: 'Taxi',
      },
      confirmation: 'step_up',
      amount: 120,
    });
    const { calls } = mountPanel(
      panelView({ apps: [app()], pendingApprovals: 1 }),
      {
        [PENDING]: { status: 200, body: { items: [money] } },
        'POST https://api.example.test/v1/auth/reauth': {
          status: 200,
          body: { reauthToken: 'rt-1' },
        },
        [`POST ${BASE}/ai/approvals/a1/approve`]: (_body, headers) =>
          headers.get('x-reauth-token') === 'rt-1'
            ? {
                status: 200,
                body: { ...money, status: 'approved', decidedAt: '2026-11-23T10:01:00Z' },
              }
            : { status: 403, body: { error: { code: 'reauthentication_required', message: 'x' } } },
      },
      { tab: 'own' },
    );
    expect(await screen.findByText('Needs your confirmation')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /^Review/ }));
    expect(await screen.findByRole('button', { name: 'Back to waiting' })).toBeTruthy();

    const form = document.querySelector<HTMLFormElement>('form.tm-aip-review__form')!;
    fireEvent.change(within(form).getByLabelText(/Type the amount to confirm/), {
      target: { value: '12' },
    });
    fireEvent.change(within(form).getByLabelText(/Password/), { target: { value: 'pw' } });
    fireEvent.submit(form);
    expect(await within(form).findByText(WRONG_AMOUNT)).toBeTruthy();
    await waitFor(() => expect(calls.some((call) => call.key.startsWith('POST'))).toBe(false));

    fireEvent.change(within(form).getByLabelText(/Type the amount to confirm/), {
      target: { value: '120' },
    });
    fireEvent.submit(form);
    await waitFor(() =>
      expect(calls.find((call) => call.key.endsWith('/approve'))?.body).toEqual({ amount: 120 }),
    );
    expect(calls.find((call) => call.key.endsWith('/approve'))!.headers.get('x-reauth-token')).toBe(
      'rt-1',
    );
  });

  it('connected app: Open only for a verified client id, in a new tab, and Disconnect asks first', async () => {
    const { calls } = mountPanel(
      panelView({
        apps: [
          app(),
          app({ grantId: 'g2', clientName: 'My agent', verified: false, app: null, openUrl: null }),
        ],
      }),
      { [`POST ${BASE}/oauth/grants/g2/revoke`]: { status: 204, body: null } },
      { tab: 'own' },
    );
    const open = await screen.findByRole('link', { name: 'Open Claude in a new tab' });
    expect(open.getAttribute('href')).toBe('https://claude.ai/new');
    expect(open.getAttribute('target')).toBe('_blank');
    expect(open.getAttribute('rel')).toContain('noopener');
    expect(screen.queryByRole('link', { name: 'Open My agent in a new tab' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Disconnect My agent' }));
    expect(calls.some((call) => call.key.includes('/revoke'))).toBe(false);
    const dialog = await screen.findByRole('dialog', { name: 'Disconnect My agent?' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Disconnect' }));
    await waitFor(() =>
      expect(calls.some((call) => call.key === `POST ${BASE}/oauth/grants/g2/revoke`)).toBe(true),
    );
  });

  it('nothing connected: the 3-step connect flow instead of the lists', async () => {
    mountPanel(panelView({ apps: [] }), {}, { tab: 'own' });
    expect(await screen.findByRole('heading', { name: 'Connect your AI' })).toBeTruthy();
    expect(screen.getByRole('group', { name: 'Choose your assistant' })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Activity' })).toBeNull();
  });

  it('could not load: the line and Try again', () => {
    mountPanel(panelView(), {}, { tab: 'own', failed: true });
    expect(screen.getByText('Could not load Your AI.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
  });

  it('activity: the row names the item and its project; empty and failed say so', async () => {
    mountPanel(
      panelView({ apps: [app()] }),
      { [ACTIVITY]: { status: 200, body: { items: [activity()], nextCursor: null } } },
      { tab: 'own' },
    );
    const section = (await screen.findByRole('heading', { name: 'Activity' })).closest('section')!;
    expect(await within(section).findByText('Homepage hero copy')).toBeTruthy();
    expect(within(section).getByText(/Website relaunch/)).toBeTruthy();
    // One day, today: no date line (858:906); the time sits on the row.
  });

  it('activity empty', async () => {
    mountPanel(panelView({ apps: [app()] }), {}, { tab: 'own' });
    expect(
      await screen.findByText('Nothing yet. What your AI reads or changes shows here.'),
    ).toBeTruthy();
  });

  it('activity failed: the line and Try again', async () => {
    mountPanel(
      panelView({ apps: [app()] }),
      { [ACTIVITY]: { status: 500, body: { error: { code: 'internal_error', message: 'x' } } } },
      { tab: 'own' },
    );
    expect(await screen.findByText('Could not load the activity.')).toBeTruthy();
  });
});

describe('Approve page: a money request needs the step-up (API AI-PANEL-API)', () => {
  it('asks for the amount and the password, refuses a wrong amount, then sends both', async () => {
    const money = approval({
      summary: { ...approval().summary, opId: 'expenses.approve', title: 'Approve an expense' },
      confirmation: 'step_up',
      amount: 120,
    });
    const { api, calls } = client({
      [`GET ${BASE}/ai/approvals/a1`]: { status: 200, body: money },
      'POST https://api.example.test/v1/auth/reauth': {
        status: 200,
        body: { reauthToken: 'rt-9' },
      },
      [`POST ${BASE}/ai/approvals/a1/approve`]: {
        status: 200,
        body: { ...money, status: 'approved', decidedAt: '2026-11-23T10:01:00Z' },
      },
    });
    const queries = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queries}>
        <AiApproveScreen
          orgSlug="northstar"
          approvalId="a1"
          client={api}
          now={() => NOW.getTime()}
        />
      </QueryClientProvider>,
    );
    const amount = await screen.findByLabelText(/Type the amount to confirm/);
    fireEvent.change(amount, { target: { value: '12' } });
    fireEvent.change(screen.getByLabelText(/Password/), { target: { value: 'pw' } });
    fireEvent.click(screen.getByRole('button', { name: /Approve/ }));
    expect(await screen.findByText(WRONG_AMOUNT)).toBeTruthy();
    expect(calls.some((call) => call.key.startsWith('POST'))).toBe(false);

    fireEvent.change(amount, { target: { value: '120' } });
    fireEvent.click(screen.getByRole('button', { name: /Approve/ }));
    await waitFor(() =>
      expect(calls.find((call) => call.key.endsWith('/approve'))?.body).toEqual({ amount: 120 }),
    );
    expect(calls.find((call) => call.key.endsWith('/approve'))!.headers.get('x-reauth-token')).toBe(
      'rt-9',
    );
  });
});
