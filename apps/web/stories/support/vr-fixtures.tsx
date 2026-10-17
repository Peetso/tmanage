import type { Decorator } from '@storybook/react-vite';
import { ApiClient } from '../../src/lib/api/client';
import type {
  CreatedPersonalAccessTokenView,
  PersonalAccessTokenView,
} from '../../src/lib/api/personal-access-tokens';
import type { InsightsPortfolio } from '../../src/lib/api/insights-portfolio';
import type { BillingSeat } from '../../src/lib/api/billing-seats';
import type { InvoiceSummary } from '../../src/lib/api/invoices';
import type { OrgPolicyView } from '../../src/lib/api/policies';
import type { PolicySimulationView } from '../../src/lib/api/policy-simulate';
import type { WorkflowTemplateSummary } from '../../src/lib/api/automations';
import type { AutomationScheduleSummary } from '../../src/lib/api/automation-schedules';
import type { PersonSummary } from '../../src/lib/api/people';
import type { UserPreferencesView } from '../../src/lib/api/preferences';
import type { QuietHoursView } from '../../src/lib/api/quiet-hours';
import type { ClientMilestone, PortalProject } from '../../src/lib/api/portal';
import type { MaintenanceWindowView } from '../../src/lib/api/maintenance';

/**
 * Fixtures and decorators shared by the visual-regression stories (the `[vr]`-tagged ones under
 * `apps/web/stories`). Everything here runs in the Storybook iframe, so the decorators patch the
 * browser globals the screens reach for and the play helpers drive the DOM directly — no
 * `storybook/test` import, because the one thing these need is a real click and a readiness flag,
 * not an assertion library.
 *
 * The response bodies are the same ones the screens' own tests use (`copilot-answer-view.test.tsx`,
 * `insights-portfolio-mobile-summary.test.tsx`), for the reason `stub-client.ts` gives: two
 * fixtures for one screen means the story and the test are looking at different screens, and only
 * one of them is checked.
 */

interface Call {
  readonly url: string;
  readonly method: string;
}

function json(body: unknown, status = 200): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function clientOver(handler: (call: Call) => Response): ApiClient {
  return new ApiClient({
    baseUrl: 'https://api.example.test',
    csrfCookieName: 'tm_session_csrf',
    fetch: ((input: RequestInfo | URL, init?: RequestInit) =>
      Promise.resolve(
        handler({ url: String(input), method: (init?.method ?? 'GET').toUpperCase() }),
      )) as typeof globalThis.fetch,
    readCsrfToken: () => 'csrf-story',
    newCorrelationId: () => 'correlation-story',
  });
}

/* ------------------------------------------------------------------ Security / PATs */

const EXISTING_TOKEN: PersonalAccessTokenView = {
  id: 'pat-001',
  name: 'Claude Desktop on my laptop',
  tokenPrefix: 'tmp_7f3a',
  lastUsedAt: '2026-10-15T08:30:00.000Z',
  expiresAt: '2027-01-13T00:00:00.000Z',
  createdAt: '2026-09-01T09:00:00.000Z',
  revokedAt: null,
};

const REVOKED_TOKEN: PersonalAccessTokenView = {
  id: 'pat-000',
  name: 'Old CI runner',
  tokenPrefix: 'tmp_1b22',
  lastUsedAt: '2026-08-20T12:00:00.000Z',
  expiresAt: null,
  createdAt: '2026-07-10T09:00:00.000Z',
  revokedAt: '2026-08-25T10:00:00.000Z',
};

const CREATED_TOKEN_VIEW: PersonalAccessTokenView = {
  id: 'pat-002',
  name: 'MCP server — reporting',
  tokenPrefix: 'tmp_9c4d',
  lastUsedAt: null,
  expiresAt: null,
  createdAt: '2026-10-17T09:00:00.000Z',
  revokedAt: null,
};

const CREATED_TOKEN: CreatedPersonalAccessTokenView = {
  ...CREATED_TOKEN_VIEW,
  token: 'tmp_9c4d8e21f05b47a6b9d3c0e1a2f4650d9ab7c3e8',
};

/**
 * A personal-access-token client with just enough memory to prove the see-once flow: `GET` lists
 * the tokens it holds, `POST` returns the created token once (plaintext and all) and files its
 * tokenless view so the refetched list shows it, `DELETE` succeeds. Starts from whatever tokens
 * the story seeds.
 */
export function tokensClient(initial: readonly PersonalAccessTokenView[]): ApiClient {
  const tokens: PersonalAccessTokenView[] = [...initial];
  return clientOver(({ url, method }) => {
    if (!url.includes('/personal-access-tokens')) return json({ status: 404 }, 404);
    if (method === 'POST') {
      tokens.unshift(CREATED_TOKEN_VIEW);
      return json(CREATED_TOKEN);
    }
    if (method === 'DELETE') return json(undefined, 204);
    return json({ tokens });
  });
}

export const SECURITY_TOKENS: readonly PersonalAccessTokenView[] = [EXISTING_TOKEN, REVOKED_TOKEN];

/* ------------------------------------------------------------------ Copilot answer */

const COPILOT_ANSWER = {
  answer:
    'Three projects are carrying blocked work this week; the Rebrand has the most, and two approvals are waiting on changes. This is a guided answer from the offline preview, not a live model.',
  evidence: [
    { source: 'Global search', link: '/search?q=blocked' },
    { source: 'Insights portfolio', link: '/insights/portfolio' },
  ],
  permissionBoundary: {
    scope: 'assigned-projects',
    canSee: 'the projects you are a member of',
    cannotSee: 'projects you are not a member of, and client-only data',
  },
  nextSafeAction: 'Open global search for "blocked" to review the underlying records yourself.',
  provider: 'local-stub',
} as const;

/** Answers the copilot ask with the guided offline answer; 404s everything else. */
export function copilotClient(): ApiClient {
  return clientOver(({ url }) =>
    url.includes('/copilot/ask') ? json(COPILOT_ANSWER) : json({ status: 404 }, 404),
  );
}

/* ------------------------------------------------------------------ Quick capture */

const CAPTURE_PROJECTS = [
  {
    id: 'project-1',
    workspaceId: 'ws-1',
    name: 'Rebrand',
    status: 'active',
    ownerUserId: null,
    forecastAt: null,
    committedAt: null,
    createdAt: '2026-09-01T09:00:00.000Z',
    updatedAt: '2026-09-01T09:00:00.000Z',
    archivedAt: null,
  },
  {
    id: 'project-2',
    workspaceId: 'ws-1',
    name: 'Website relaunch',
    status: 'active',
    ownerUserId: null,
    forecastAt: null,
    committedAt: null,
    createdAt: '2026-09-02T09:00:00.000Z',
    updatedAt: '2026-09-02T09:00:00.000Z',
    archivedAt: null,
  },
];

/** Answers the capture screen's project list; 404s everything else. */
export function projectsClient(): ApiClient {
  return clientOver(({ url }) =>
    url.includes('/projects') ? json({ projects: CAPTURE_PROJECTS }) : json({ status: 404 }, 404),
  );
}

/* ------------------------------------------------------------------ Insights portfolio (mobile) */

function flow(blocked: number, itemCount: number) {
  return {
    projectId: 'ignored',
    counts: {
      backlog: 1,
      ready: 0,
      in_progress: 2,
      blocked,
      internal_review: 0,
      done: 1,
      archived: 0,
    },
    itemCount,
    computedAt: '2026-09-20T10:00:00.000Z',
  };
}

function cycle(changesRequested: number) {
  return {
    projectId: 'ignored',
    metrics: {
      approved: { count: 2, decidedCount: 2, totalDurationMs: 0 },
      changes_requested: {
        count: changesRequested,
        decidedCount: changesRequested,
        totalDurationMs: 0,
      },
      invalidated: { count: 0, decidedCount: 0, totalDurationMs: 0 },
    },
    approvalCount: 2 + changesRequested,
    computedAt: '2026-09-20T10:00:00.000Z',
  };
}

export const INSIGHTS_PORTFOLIO = {
  projects: [
    { projectId: 'project-1', name: 'Rebrand', deliveryFlow: flow(3, 7), approvalCycle: cycle(2) },
    {
      projectId: 'project-3',
      name: 'Onboarding revamp',
      deliveryFlow: flow(1, 5),
      approvalCycle: cycle(1),
    },
    { projectId: 'project-2', name: 'Website', deliveryFlow: flow(0, 4), approvalCycle: cycle(0) },
  ],
  projectCount: 3,
  computedAt: '2026-09-20T10:00:00.000Z',
} as unknown as InsightsPortfolio;

/* ------------------------------------------------------------------ Billing */

const BILLING_SEATS: readonly BillingSeat[] = [
  {
    id: 'seat-1',
    membershipId: 'mem-ava',
    assignedAt: '2026-09-01T09:00:00.000Z',
    releasedAt: null,
  },
  {
    id: 'seat-2',
    membershipId: 'mem-liam',
    assignedAt: '2026-09-18T14:30:00.000Z',
    releasedAt: null,
  },
];

/** The seats list: two active seats against the plan. */
export function billingSeatsClient(): ApiClient {
  return clientOver(({ url }) =>
    url.includes('/billing/seats')
      ? json({ seats: BILLING_SEATS, activeCount: BILLING_SEATS.length })
      : json({ status: 404 }, 404),
  );
}

const INVOICES: readonly InvoiceSummary[] = [
  {
    id: 'inv-3',
    number: 'TM-2026-0003',
    periodStart: '2026-09-01',
    periodEnd: '2026-09-30',
    amountCents: 24900,
    currency: 'USD',
    status: 'open',
    issuedAt: '2026-10-01',
  },
  {
    id: 'inv-2',
    number: 'TM-2026-0002',
    periodStart: '2026-08-01',
    periodEnd: '2026-08-31',
    amountCents: 24900,
    currency: 'USD',
    status: 'paid',
    issuedAt: '2026-09-01',
  },
  {
    id: 'inv-1',
    number: 'TM-2026-0001',
    periodStart: '2026-07-01',
    periodEnd: '2026-07-31',
    amountCents: 9900,
    currency: 'USD',
    status: 'paid',
    issuedAt: '2026-08-01',
  },
];

/** The invoice history, newest first; no invoice selected, so the detail stays closed. */
export function invoicesClient(): ApiClient {
  return clientOver(({ url }) =>
    url.includes('/billing/invoices') ? json({ invoices: INVOICES }) : json({ status: 404 }, 404),
  );
}

/* ------------------------------------------------------------------ Admin policies */

const ORG_POLICY: OrgPolicyView = {
  policy: {
    session_max_hours: 72,
    invite_domain_allowlist: ['northstar.example', 'contractors.northstar.example'],
    guest_access_enabled: false,
  },
};

/** The stored access policy the admin form seeds from. */
export function orgPolicyClient(): ApiClient {
  return clientOver(({ url }) =>
    url.includes('/policies') ? json(ORG_POLICY) : json({ status: 404 }, 404),
  );
}

const POLICY_DECISION: PolicySimulationView = {
  result: {
    memberId: 'mem-ava',
    role: 'manager',
    capability: 'project.manage',
    allowed: true,
    decidingRule: 'role:manager grants project.manage',
    detail: 'Managers may manage the projects they are assigned to.',
    denialCode: null,
  },
};

/** Answers the read-only "can this member do this?" POST with an allow decision. */
export function policySimulateClient(): ApiClient {
  return clientOver(({ url, method }) =>
    method === 'POST' && url.includes('/policies/simulate')
      ? json(POLICY_DECISION)
      : json({ status: 404 }, 404),
  );
}

/* ------------------------------------------------------------------ Automations */

const AUTOMATION_TEMPLATES: readonly WorkflowTemplateSummary[] = [
  {
    id: 'tpl-1',
    name: 'Notify owner on new request',
    triggerKind: 'request_submitted',
    actionKind: 'notify_owner',
    config: {},
    enabled: true,
    createdBy: 'mem-ava',
    createdAt: '2026-09-10T09:00:00.000Z',
  },
  {
    id: 'tpl-2',
    name: 'Weekly digest email',
    triggerKind: 'meeting_scheduled',
    actionKind: 'send_email_digest',
    config: {},
    enabled: false,
    createdBy: 'mem-liam',
    createdAt: '2026-09-12T09:00:00.000Z',
  },
];

/** The organization's workflow templates — one enabled, one disabled. */
export function automationTemplatesClient(): ApiClient {
  return clientOver(({ url }) =>
    url.includes('/automations/templates')
      ? json({ templates: AUTOMATION_TEMPLATES })
      : json({ status: 404 }, 404),
  );
}

const AUTOMATION_SCHEDULES: readonly AutomationScheduleSummary[] = [
  {
    id: 'sch-1',
    templateId: 'tpl-1',
    spec: { interval: 'daily', hour: 9 },
    nextRunAt: '2026-10-18T09:00:00.000Z',
    enabled: true,
    createdAt: '2026-09-20T09:00:00.000Z',
  },
  {
    id: 'sch-2',
    templateId: 'tpl-2',
    spec: { interval: 'weekly', hour: 8, dayOfWeek: 1 },
    nextRunAt: '2026-10-20T08:00:00.000Z',
    enabled: false,
    createdAt: '2026-09-21T09:00:00.000Z',
  },
];

/** The scheduled triggers list — a daily and a weekly schedule. */
export function automationSchedulesClient(): ApiClient {
  return clientOver(({ url }) =>
    url.includes('/automations/schedules')
      ? json({ schedules: AUTOMATION_SCHEDULES })
      : json({ status: 404 }, 404),
  );
}

/* ------------------------------------------------------------------ People directory */

const PEOPLE: readonly PersonSummary[] = [
  { userId: 'u-ava', displayName: 'Ava Romero', role: 'owner', status: 'active', projectCount: 4 },
  {
    userId: 'u-liam',
    displayName: 'Liam Osei',
    role: 'manager',
    status: 'active',
    projectCount: 2,
  },
  {
    userId: 'u-noa',
    displayName: 'Noa Feldman',
    role: 'member',
    status: 'active',
    projectCount: 1,
  },
  {
    userId: 'u-sana',
    displayName: 'Sana Qureshi',
    role: 'member',
    status: 'active',
    projectCount: 0,
  },
];

/** The organization roster the directory lists; the search starts empty, so all rows show. */
export function peopleClient(): ApiClient {
  return clientOver(({ url }) =>
    url.includes('/people')
      ? json({ people: PEOPLE, nextAfter: null })
      : json({ status: 404 }, 404),
  );
}

/* ------------------------------------------------------------------ Preferences */

const PREFERENCES: UserPreferencesView = {
  theme: 'system',
  locale: 'en-GB',
  density: 'comfortable',
};

/** The stored appearance / language row the preferences form seeds from. */
export function preferencesClient(): ApiClient {
  return clientOver(({ url }) =>
    url.includes('/me/preferences') ? json(PREFERENCES) : json({ status: 404 }, 404),
  );
}

const QUIET_HOURS: QuietHoursView = {
  enabled: true,
  startTime: '21:00',
  endTime: '07:30',
  timezone: 'Europe/London',
  days: [1, 2, 3, 4, 5],
};

/** The stored do-not-disturb window the quiet-hours form seeds from. */
export function quietHoursClient(): ApiClient {
  return clientOver(({ url }) =>
    url.includes('/preferences/quiet-hours') ? json(QUIET_HOURS) : json({ status: 404 }, 404),
  );
}

/* ------------------------------------------------------------------ Client portal */

const PORTAL_PROJECTS: readonly PortalProject[] = [
  {
    id: 'proj-rebrand',
    name: 'Rebrand',
    status: 'active',
    committedAt: '2026-12-15T00:00:00.000Z',
    forecastAt: '2026-12-20T00:00:00.000Z',
  },
];

const PORTAL_MILESTONES: readonly ClientMilestone[] = [
  {
    id: 'ms-1',
    projectId: 'proj-rebrand',
    title: 'Discovery complete',
    dueOn: '2026-10-10',
    status: 'met',
    createdAt: '2026-09-01T09:00:00.000Z',
  },
  {
    id: 'ms-2',
    projectId: 'proj-rebrand',
    title: 'Design system approved',
    dueOn: '2026-11-05',
    status: 'planned',
    createdAt: '2026-09-01T09:00:00.000Z',
  },
  {
    id: 'ms-3',
    projectId: 'proj-rebrand',
    title: 'Beta launch',
    dueOn: '2026-12-01',
    status: 'planned',
    createdAt: '2026-09-01T09:00:00.000Z',
  },
];

/**
 * The client portal's first shared project and its published milestones. The milestones endpoint
 * names the project in its path, so it is matched before the bare projects list.
 */
export function portalMilestonesClient(): ApiClient {
  return clientOver(({ url }) => {
    if (url.includes('/portal/projects/') && url.includes('/milestones')) {
      return json({ milestones: PORTAL_MILESTONES });
    }
    if (url.includes('/portal/projects')) return json({ projects: PORTAL_PROJECTS });
    return json({ status: 404 }, 404);
  });
}

/* ------------------------------------------------------------------ Platform states */

/** A degraded-service window the maintenance banner renders from, without a fetch. */
export const MAINTENANCE_DEGRADED: MaintenanceWindowView = {
  id: 'mw-degraded',
  message:
    'Search and exports are running slowly while we migrate a database. Everything else is working normally.',
  severity: 'degraded',
  startsAt: '2026-10-17T08:00:00.000Z',
  endsAt: '2026-10-17T12:00:00.000Z',
  active: true,
};

/** A full maintenance (down) window — the banner's most severe surface. */
export const MAINTENANCE_DOWN: MaintenanceWindowView = {
  id: 'mw-down',
  message:
    'TManage is briefly offline for scheduled maintenance. We expect to be back by 02:00 UTC.',
  severity: 'down',
  startsAt: '2026-10-18T01:00:00.000Z',
  endsAt: '2026-10-18T02:00:00.000Z',
  active: true,
};

/* ------------------------------------------------------------------ decorators */

/**
 * Neutralise every API call a screen's *shell* makes on its own.
 *
 * `AppShell` mounts `MaintenanceBanner` (and friends) which reach for the process-wide browser
 * client rather than a story's injected one, so without this they would fire a real request at
 * whatever origin `public-config.ts` resolved — a hang, then a flake. This replaces `fetch` with
 * one that refuses any `/v1/` API call instantly and passes everything else (Storybook's own
 * runtime) straight through.
 */
export const withStubbedNetwork: Decorator = (Story) => {
  if (typeof window !== 'undefined' && !('__vrFetchStubbed' in window)) {
    const original = window.fetch.bind(window);
    (window as unknown as { __vrFetchStubbed: boolean }).__vrFetchStubbed = true;
    window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.includes('/v1/')) {
        return Promise.resolve(
          new Response(JSON.stringify({ status: 503, detail: 'No API in Storybook.' }), {
            status: 503,
            headers: { 'content-type': 'application/json' },
          }),
        );
      }
      return original(input as RequestInfo, init);
    }) as typeof window.fetch;
  }
  return <Story />;
};

/**
 * Put a fresh service worker in the *waiting* state so `UpdateToast` shows its "update available"
 * offer — the one state it reaches only from a live registration. Installs a minimal fake
 * `navigator.serviceWorker` (a controller, and a registration already holding a waiting worker)
 * before the component mounts. The `reload` button's `postMessage`/reload are stubbed so a shot
 * can never trigger a navigation.
 */
export const withWaitingServiceWorker: Decorator = (Story) => {
  if (typeof navigator !== 'undefined') {
    const waiting = { postMessage() {} } as unknown as ServiceWorker;
    const registration = {
      waiting,
      installing: null,
      addEventListener() {},
    } as unknown as ServiceWorkerRegistration;
    const fake = {
      controller: {} as ServiceWorker,
      getRegistration: () => Promise.resolve(registration),
      addEventListener() {},
      removeEventListener() {},
    };
    try {
      Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: fake });
    } catch {
      // Some engines refuse to redefine it; the toast then stays hidden, which the baseline shows
      // honestly rather than faking a state the browser would not produce.
    }
  }
  return <Story />;
};

/* ------------------------------------------------------------------ play helpers */

/** Signal to the VR spec that a scripted story has reached its target state. */
export function markVrReady(): void {
  if (typeof document !== 'undefined') document.documentElement.dataset['vrReady'] = '1';
}

/** Poll for an element matching `selector` within `root`, up to `timeout` ms. */
export async function waitForElement<T extends Element = Element>(
  root: ParentNode,
  selector: string,
  timeout = 5_000,
): Promise<T> {
  const start = Date.now();
  for (;;) {
    const found = root.querySelector<T>(selector);
    if (found) return found;
    if (Date.now() - start > timeout) throw new Error(`timed out waiting for ${selector}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/** Set a React-controlled input's value through the native setter so React's onChange fires. */
export function setReactInputValue(input: HTMLInputElement, value: string): void {
  const descriptor = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value');
  descriptor?.set?.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}
