import type { Meta, StoryObj } from '@storybook/react-vite';
import { PHONE_VIEWPORT } from '../.storybook/vr-viewport';
import { ApiClient } from '../src/lib/api/client';
import type { AiApprovalView } from '../src/lib/api/ai-approvals';
import type { AiActivityItem, AiPanelApp, AiPanelView } from '../src/lib/api/ai-panel';
import type { AiCreditsView } from '../src/lib/api/ai-credits';
import { AiPanel } from '../src/components/ai-panel/AiPanel';
import { ARABIC_STORY } from './support/arabic';
import { markVrReady, waitForElement, withStubbedNetwork } from './support/vr-fixtures';

/**
 * **The two-tab AI panel** (Figma ZdUCRiqBiT7s3u08HA28RO, section 851:906). Tab 1 is the TManage
 * AI chat (857:906), tab 2 is Your AI (857:1014; nothing connected 857:1285; the step-up review
 * 858:906; Your AI only 857:1377; TManage AI off 857:1715; phone 860:1021). The dictation menu in
 * the composer is 878:976 (EN) / 878:1180 (AR). Every story reads a fixed clock and a stubbed
 * client, so each shot is the same on every run; the panel is fixed to the viewport edge, so the
 * baselines are whole-viewport shots (`vr-fullpage`).
 */

const NOW = new Date('2026-11-23T10:00:00Z');
const SLUG = 'northstar';

const VIEW: AiPanelView = {
  tmanageAi: { inPlan: true, enabled: true, available: true, reason: null, canManage: true },
  ownAi: { enabled: true, reason: null, canManage: true },
  apps: [],
  pendingApprovals: 0,
};

const CLAUDE: AiPanelApp = {
  grantId: 'g1',
  clientName: 'Claude',
  verified: true,
  app: 'claude',
  openUrl: 'https://claude.ai/new',
  connectedAt: '2026-11-02T09:00:00Z',
  lastUsedAt: '2026-11-23T09:52:00Z',
};

const CURSOR: AiPanelApp = {
  grantId: 'g2',
  clientName: 'Cursor',
  verified: true,
  app: 'cursor',
  openUrl: null,
  connectedAt: '2026-11-12T09:00:00Z',
  lastUsedAt: '2026-11-21T16:10:00Z',
};

const CONNECTED: AiPanelView = { ...VIEW, apps: [CLAUDE, CURSOR], pendingApprovals: 2 };

const TASK_CHANGE: AiApprovalView = {
  id: 'a1',
  status: 'pending',
  clientName: 'Claude',
  memberName: 'Lina Haddad',
  memberEmail: 'lina@example.test',
  summary: {
    opId: 'work_items.update',
    title: 'Change a task',
    method: 'PATCH',
    destructive: false,
    notifies: false,
    subject: 'Homepage hero copy',
    fields: [
      { name: 'Due date', value: 'Mon 30 Nov' },
      { name: 'Assignee', value: 'Mona Samir' },
    ],
  },
  confirmation: 'none',
  amount: null,
  expiresAt: '2026-11-23T10:30:00Z',
  decidedAt: null,
};

const EXPENSE: AiApprovalView = {
  ...TASK_CHANGE,
  id: 'a2',
  summary: {
    opId: 'expenses.approve',
    title: 'Approve an expense',
    method: 'POST',
    destructive: false,
    notifies: true,
    subject: 'Taxi to the client workshop',
    fields: [
      { name: 'Amount', value: 'EGP 1,250.00' },
      { name: 'Submitted by', value: 'Karim Aziz' },
    ],
  },
  confirmation: 'step_up',
  amount: 1250,
};

const ACTIVITY: readonly AiActivityItem[] = [
  {
    id: 'e1',
    at: '2026-11-23T09:52:00Z',
    verb: 'changed',
    failed: false,
    clientName: 'Claude',
    app: 'claude',
    kind: 'work_item',
    count: null,
    itemId: 'w1',
    itemName: 'Homepage hero copy',
    projectId: 'p1',
    projectName: 'Website relaunch',
  },
  {
    id: 'e2',
    at: '2026-11-23T09:41:00Z',
    verb: 'read',
    failed: false,
    clientName: 'Claude',
    app: 'claude',
    kind: 'work_item',
    count: 12,
    itemId: null,
    itemName: null,
    projectId: 'p1',
    projectName: 'Website relaunch',
  },
  {
    id: 'e3',
    at: '2026-11-22T15:20:00Z',
    verb: 'waiting',
    failed: false,
    clientName: 'Cursor',
    app: 'cursor',
    kind: 'expense',
    count: null,
    itemId: 'x1',
    itemName: 'Taxi to the client workshop',
    projectId: null,
    projectName: null,
  },
  {
    id: 'e4',
    at: '2026-11-22T11:05:00Z',
    verb: 'changed',
    failed: true,
    clientName: 'Cursor',
    app: 'cursor',
    kind: 'document',
    count: null,
    itemId: null,
    itemName: null,
    projectId: null,
    projectName: null,
  },
] as unknown as readonly AiActivityItem[];

const CREDITS: AiCreditsView = {
  periodStart: '2026-11-01',
  resetsOn: '2026-12-01',
  allowanceCredits: 2000,
  limitedBy: 'plan',
  raisedBySupport: false,
  packCreditsThisMonth: 0,
  usedCredits: 1240,
  heldCredits: 0,
  remainingCredits: 760,
  packBalanceCredits: 0,
  packs: [],
  memberShareCredits: 1000,
  openRequest: null,
  canRequestPack: true,
};

const CONVERSATIONS = {
  retentionDays: 30,
  items: [
    {
      id: 'c1',
      title: 'Which tasks are late this week?',
      createdAt: '2026-11-18T08:00:00Z',
      lastMessageAt: '2026-11-18T08:04:00Z',
    },
    {
      id: 'c2',
      title: 'Draft the client update for Atlas',
      createdAt: '2026-11-16T12:00:00Z',
      lastMessageAt: '2026-11-16T12:09:00Z',
    },
    {
      id: 'c3',
      title: 'How many hours did we log on the relaunch?',
      createdAt: '2026-11-12T09:30:00Z',
      lastMessageAt: '2026-11-12T09:31:00Z',
    },
  ],
};

interface Seed {
  readonly approvals?: readonly AiApprovalView[];
  readonly activity?: readonly AiActivityItem[];
  readonly activityFails?: boolean;
}

function client(seed: Seed = {}): ApiClient {
  const reply = (url: string): { status: number; body: unknown } => {
    if (url.includes('/ai/approvals'))
      return { status: 200, body: { items: seed.approvals ?? [] } };
    if (url.includes('/ai/activity'))
      return seed.activityFails
        ? {
            status: 500,
            body: { error: { code: 'internal_error', message: 'x', correlationId: 'c' } },
          }
        : { status: 200, body: { items: seed.activity ?? [], nextCursor: null } };
    if (url.includes('/ai/credits')) return { status: 200, body: CREDITS };
    if (url.includes('/copilot/conversations')) return { status: 200, body: CONVERSATIONS };
    return {
      status: 404,
      body: { error: { code: 'not_found', message: 'x', correlationId: 'c' } },
    };
  };
  return new ApiClient({
    baseUrl: 'https://api.example.test',
    csrfCookieName: 'tm_session_csrf',
    fetch: ((input: RequestInfo | URL) => {
      const { status, body } = reply(String(input));
      return Promise.resolve(
        new Response(JSON.stringify(body), {
          status,
          headers: { 'content-type': 'application/json' },
        }),
      );
    }) as typeof globalThis.fetch,
    readCsrfToken: () => 'csrf-story',
    newCorrelationId: () => 'correlation-story',
  });
}

const FULL_SEED: Seed = { approvals: [TASK_CHANGE, EXPENSE], activity: ACTIVITY };

const meta = {
  title: 'AI/Panel two tabs',
  component: AiPanel,
  tags: ['vr', 'vr-fullpage'],
  decorators: [withStubbedNetwork],
  args: {
    api: client(FULL_SEED),
    organizationSlug: SLUG,
    layout: 'tabs',
    view: CONNECTED,
    initialTab: 'tmanage',
    address: 'https://api.tmanageapp.com/mcp',
    onClose: () => {},
    onRetry: () => {},
    now: () => NOW,
  },
  beforeEach: () => {
    // The dictation chip reads the member's saved choice; every story starts from the app language.
    window.localStorage.removeItem(`tm.voice.dictationLanguage.${SLUG}`);
  },
} satisfies Meta<typeof AiPanel>;

export default meta;
type Story = StoryObj<typeof meta>;

/** 857:906: tab 1, the TManage AI chat, empty state with examples and the dictation chip. */
export const Tab1Chat: Story = {};

/** 857:1801: tab 1 in Arabic. */
export const Tab1ChatArabic: Story = { ...ARABIC_STORY };

/** 857:1014: tab 2 with two requests waiting (one plain, one money), activity and two apps. */
export const Tab2Connected: Story = { args: { initialTab: 'own' } };

/** 857:1907: tab 2 in Arabic. */
export const Tab2ConnectedArabic: Story = { ...ARABIC_STORY, args: { initialTab: 'own' } };

/** 857:1285: nothing connected yet, the 3-step connect flow. */
export const Tab2NothingConnected: Story = {
  args: { initialTab: 'own', view: VIEW, api: client() },
};

/** 858:906: activity could not load, the line and Try again. */
export const Tab2ActivityFailed: Story = {
  args: {
    initialTab: 'own',
    view: { ...CONNECTED, pendingApprovals: 0 },
    api: client({ activityFails: true }),
  },
};

/** 858:906: the money request's Review opens the step-up card inside tab 2. */
export const Tab2Review: Story = {
  tags: ['vr-play'],
  args: { initialTab: 'own' },
  play: async ({ canvasElement }) => {
    const root = canvasElement.ownerDocument.body;
    const review = await waitForElement<HTMLButtonElement>(
      root,
      '.tm-aip-card button[aria-label^="Review"]',
    );
    review.click();
    await waitForElement(root, '.tm-aip-review__form');
    markVrReady();
  },
};

/** 857:1715: the plan has TManage AI and the owner turned it off. */
export const TmanageAiOffOwner: Story = {
  args: {
    view: {
      ...CONNECTED,
      tmanageAi: { ...VIEW.tmanageAi, enabled: false, available: false, reason: 'ai_off' },
    },
  },
};

/** 857:1377: TManage AI not in the plan, so Your AI alone with a plain title. */
export const YourAiOnly: Story = {
  args: {
    layout: 'own-only',
    initialTab: 'own',
    view: {
      ...CONNECTED,
      tmanageAi: {
        ...VIEW.tmanageAi,
        inPlan: false,
        enabled: false,
        available: false,
        reason: 'not_on_test_list',
      },
    },
  },
};

/** 860:1021: tab 2 on a 390 px phone, Back at the start, 44 px targets. */
export const Tab2Phone: Story = {
  args: { initialTab: 'own' },
  globals: { viewport: { value: PHONE_VIEWPORT } },
};

/** 860:906: tab 1 on a 390 px phone. */
export const Tab1Phone: Story = {
  globals: { viewport: { value: PHONE_VIEWPORT } },
};

/** 789:50401: past conversations, opened from the clock icon in tab 1. */
export const Tab1History: Story = {
  tags: ['vr-play'],
  play: async ({ canvasElement }) => {
    const root = canvasElement.ownerDocument.body;
    const history = await waitForElement<HTMLButtonElement>(
      root,
      '.tm-aic__icon[aria-label="Past conversations"]',
    );
    history.click();
    await waitForElement(root, '.tm-aic-history__open');
    markVrReady();
  },
};

async function openDictation(root: HTMLElement): Promise<void> {
  const chip = await waitForElement<HTMLButtonElement>(root, '.tm-aic-dict__chip');
  chip.click();
  await waitForElement(root, '.tm-aic-dict__menu input[type="radio"]');
  markVrReady();
}

/** 878:976: the dictation language menu, open above the chip. */
export const DictationMenu: Story = {
  tags: ['vr-play'],
  play: async ({ canvasElement }) => openDictation(canvasElement.ownerDocument.body),
};

/** 878:1180: the dictation menu in Arabic, the Arabic group first. */
export const DictationMenuArabic: Story = {
  ...ARABIC_STORY,
  tags: ['vr-play'],
  play: async ({ canvasElement }) => openDictation(canvasElement.ownerDocument.body),
};
