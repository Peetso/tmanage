import { ApiClient } from '../../src/lib/api/client';
import type { ActivityEntry, ActivityPage } from '../../src/lib/api/activity';
import type { ClientSummary } from '../../src/lib/api/client-summary';
import type { ProjectSummary } from '../../src/lib/api/project-summary';

/**
 * ONEPAGE (B04) — the summaries the project overview and client company stories mount with, and
 * that `tests/overview-*.test.tsx` assert on: one fixture per state, so a story and its test look
 * at the same screen. Sample data agrees with itself (review FIGMA-C fix 3): the late milestone is
 * on an amber project, the risks say why.
 */

export const OVERVIEW_NOW = new Date('2026-11-19T10:00:00.000Z');

export const PROJECT_SUMMARY: ProjectSummary = {
  project: {
    id: 'proj-1',
    name: 'Cedar Foods brand refresh',
    status: 'active',
    committedAt: '2026-12-12T00:00:00.000Z',
    forecastAt: '2026-12-12T00:00:00.000Z',
    archivedAt: null,
  },
  delivery: { open: 18, late: 3, done: 41, complete: true },
  milestone: {
    next: { id: 'ms-1', title: 'Packaging artwork', dueOn: '2026-11-28' },
    planned: 3,
    missed: 0,
  },
  health: { band: 'amber', score: 64, overdueMilestones: 0, openRisks: 2, highRisks: 1 },
  approvals: {
    waitingOnTeam: 1,
    waitingOnClient: 2,
    items: [
      {
        deliverableId: 'dl-1',
        projectId: 'proj-1',
        title: 'Label artwork v3',
        waitingOn: 'client',
        since: '2026-11-15T09:00:00.000Z',
      },
      {
        deliverableId: 'dl-2',
        projectId: 'proj-1',
        title: 'Shoot budget change',
        waitingOn: 'team',
        since: '2026-11-18T09:00:00.000Z',
      },
      {
        deliverableId: 'dl-3',
        projectId: 'proj-1',
        title: 'Social posts, week 49',
        waitingOn: 'client',
        since: '2026-11-19T08:00:00.000Z',
      },
    ],
  },
  files: {
    items: [
      {
        id: 'f-1',
        projectId: 'proj-1',
        name: 'Packaging_dieline_v4.pdf',
        mimeType: 'application/pdf',
        updatedAt: '2026-11-19T08:24:00.000Z',
      },
      {
        id: 'f-2',
        projectId: 'proj-1',
        name: 'Brand_guidelines_2026.pdf',
        mimeType: 'application/pdf',
        updatedAt: '2026-11-18T12:00:00.000Z',
      },
      {
        id: 'f-3',
        projectId: 'proj-1',
        name: 'Moodboard.png',
        mimeType: 'image/png',
        updatedAt: '2026-11-14T12:00:00.000Z',
      },
    ],
  },
  time: {
    from: '2026-09-01',
    to: '2026-11-19',
    loggedMinutes: 126 * 60,
    billableMinutes: 112 * 60,
  },
  budget: {
    budgetHours: 154,
    trackedHours: 126,
    remainingHours: 28,
    percentBp: 8_200,
    status: 'watch',
  },
  money: {
    from: '2026-09-01',
    to: '2026-11-19',
    currency: 'AED',
    invoicedMinor: 4_800_000,
    unbilledMinor: 1_140_000,
    unbilledMinutes: 38 * 60,
    truncated: false,
  },
};

/** A member without finance access: no budget, no milestone (project.manage), no money. */
export const PROJECT_SUMMARY_NO_FINANCE: ProjectSummary = (() => {
  const { budget: _budget, milestone: _milestone, money: _money, ...rest } = PROJECT_SUMMARY;
  return rest;
})();

/** A new project: every block readable, nothing in any of them yet. */
export const PROJECT_SUMMARY_EMPTY: ProjectSummary = {
  project: { ...PROJECT_SUMMARY.project, name: 'New project' },
  delivery: { open: 0, late: 0, done: 0, complete: true },
  milestone: { next: null, planned: 0, missed: 0 },
  health: { band: 'neutral', score: 100, overdueMilestones: 0, openRisks: 0, highRisks: 0 },
  approvals: { waitingOnTeam: 0, waitingOnClient: 0, items: [] },
  files: { items: [] },
  time: { from: '2026-09-01', to: '2026-11-19', loggedMinutes: 0, billableMinutes: 0 },
  budget: {
    budgetHours: null,
    trackedHours: 0,
    remainingHours: null,
    percentBp: null,
    status: null,
  },
  money: {
    from: '2026-09-01',
    to: '2026-11-19',
    currency: null,
    invoicedMinor: 0,
    unbilledMinor: 0,
    unbilledMinutes: 0,
    truncated: false,
  },
};

export const CLIENT_SUMMARY: ClientSummary = {
  client: { id: 'co-cedar', name: 'Cedar Foods', archivedAt: null },
  projects: {
    items: [
      { id: 'proj-2', name: 'Ramadan campaign 2027', status: 'active', band: 'red' },
      { id: 'proj-1', name: 'Cedar Foods brand refresh', status: 'active', band: 'amber' },
    ],
    truncated: false,
  },
  delivery: { open: 27, late: 3, done: 68, complete: true },
  approvals: {
    waitingOnTeam: 1,
    waitingOnClient: 2,
    items: [
      {
        deliverableId: 'dl-1',
        projectId: 'proj-1',
        title: 'Label artwork v3',
        waitingOn: 'client',
        since: '2026-11-15T09:00:00.000Z',
      },
      {
        deliverableId: 'dl-3',
        projectId: 'proj-1',
        title: 'Social posts, week 49',
        waitingOn: 'client',
        since: '2026-11-19T08:00:00.000Z',
      },
      {
        deliverableId: 'dl-9',
        projectId: 'proj-2',
        title: 'Ramadan concept boards',
        waitingOn: 'team',
        since: '2026-11-16T09:00:00.000Z',
      },
    ],
  },
  files: {
    items: [
      {
        id: 'f-1',
        projectId: 'proj-1',
        name: 'Packaging_dieline_v4.pdf',
        mimeType: 'application/pdf',
        updatedAt: '2026-11-19T08:24:00.000Z',
      },
      {
        id: 'f-7',
        projectId: 'proj-2',
        name: 'Ramadan_brief.docx',
        mimeType: null,
        updatedAt: '2026-11-18T12:00:00.000Z',
      },
    ],
  },
  money: {
    totals: [
      {
        currency: 'AED',
        invoicedMinor: 9_600_000,
        paidMinor: 7_800_000,
        dueMinor: 1_800_000,
        overdueMinor: 600_000,
        overdueCount: 1,
      },
    ],
    complete: true,
  },
  unbilled: {
    from: '2026-09-01',
    to: '2026-11-19',
    currency: 'AED',
    minutes: 52 * 60,
    amountMinor: 1_560_000,
    truncated: false,
  },
};

export const CLIENT_SUMMARY_NO_FINANCE: ClientSummary = (() => {
  const { money: _money, unbilled: _unbilled, ...rest } = CLIENT_SUMMARY;
  return rest;
})();

export const CLIENT_ORGANIZATION = {
  id: 'co-cedar',
  name: 'Cedar Foods',
  createdAt: '2026-07-04T00:00:00Z',
  updatedAt: '2026-10-01T00:00:00.000Z',
  archivedAt: null,
};

export const PROJECT = {
  id: 'proj-1',
  workspaceId: 'ws-1',
  name: 'Cedar Foods brand refresh',
  status: 'active',
  ownerUserId: 'user-1',
  committedAt: '2026-12-12T00:00:00.000Z',
  forecastAt: '2026-12-12T00:00:00.000Z',
  archivedAt: null,
  createdAt: '2026-08-01T00:00:00.000Z',
  updatedAt: '2026-11-01T00:00:00.000Z',
  version: 1,
};

const MEMBERS = {
  members: [
    {
      userId: 'user-1',
      displayName: 'Omar Adel',
      email: 'omar@northstar.studio',
      role: 'manager',
      status: 'active',
    },
    {
      userId: 'user-2',
      displayName: 'Lina Saeed',
      email: 'lina@northstar.studio',
      role: 'member',
      status: 'active',
    },
  ],
};

/** B09 — minutes before {@link OVERVIEW_NOW}, as an ISO instant. */
function minutesBefore(minutes: number): string {
  return new Date(OVERVIEW_NOW.getTime() - minutes * 60_000).toISOString();
}

function activityEntry(
  id: string,
  fields: Pick<ActivityEntry, 'kind' | 'action' | 'summary' | 'objectType' | 'objectId'> & {
    readonly actorUserId?: string | null;
    readonly projectId?: string;
    readonly minutes: number;
  },
): ActivityEntry {
  return {
    id,
    kind: fields.kind,
    action: fields.action,
    phraseKey: `activity.phrase.${fields.action}`,
    summary: fields.summary,
    actorUserId: fields.actorUserId === undefined ? 'user-1' : fields.actorUserId,
    objectType: fields.objectType,
    objectId: fields.objectId,
    projectId: fields.projectId ?? 'proj-1',
    clientOrganizationId: 'co-cedar',
    occurredAt: minutesBefore(fields.minutes),
  };
}

/**
 * B09 — the Activity tab's first page as a holder of `finance.view` reads it (FIGMA-D 753:41712):
 * today, yesterday and an older day; one money line; more behind "Load more".
 */
export const ACTIVITY_PAGE: ActivityPage = {
  entries: [
    activityEntry('act-1', {
      kind: 'work',
      action: 'work_item.transitioned',
      summary: 'Changed the status of a task',
      objectType: 'work_item',
      objectId: 'wi-7',
      minutes: 5,
    }),
    activityEntry('act-2', {
      kind: 'files',
      action: 'file_asset.uploaded',
      summary: 'Uploaded a file',
      objectType: 'file_asset',
      objectId: 'file-3',
      actorUserId: 'user-2',
      minutes: 40,
    }),
    activityEntry('act-3', {
      kind: 'time',
      action: 'time_log.created',
      summary: 'Logged time',
      objectType: 'time_log',
      objectId: 'tl-4',
      minutes: 60 * 24 + 30,
    }),
    activityEntry('act-4', {
      kind: 'money',
      action: 'client_invoice.sent',
      summary: 'Sent an invoice',
      objectType: 'client_invoice',
      objectId: 'inv-42',
      projectId: 'proj-2',
      minutes: 60 * 24 + 90,
    }),
    activityEntry('act-5', {
      kind: 'project',
      action: 'project.created',
      summary: 'Created the project',
      objectType: 'project',
      objectId: 'proj-1',
      actorUserId: null,
      minutes: 60 * 24 * 5,
    }),
  ],
  nextCursor: 'cursor-2',
};

/** B09 — the page behind "Load more". */
export const ACTIVITY_PAGE_2: ActivityPage = {
  entries: [
    activityEntry('act-6', {
      kind: 'approvals',
      action: 'approval.approved',
      summary: 'Approved a version',
      objectType: 'approval',
      objectId: 'ap-1',
      actorUserId: 'user-2',
      minutes: 60 * 24 * 9,
    }),
  ],
  nextCursor: null,
};

/** The same first page as someone without finance access is given it: no money line at all. */
export const ACTIVITY_PAGE_NO_FINANCE: ActivityPage = {
  entries: ACTIVITY_PAGE.entries.filter((entry) => entry.kind !== 'money'),
  nextCursor: 'cursor-2',
};

export const ACTIVITY_EMPTY: ActivityPage = { entries: [], nextCursor: null };

function reply(body: unknown, status = 200): Promise<Response> {
  return Promise.resolve(
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    }),
  );
}

export interface OverviewRoutes {
  readonly projectSummary?: ProjectSummary | 'fail' | 'pending';
  readonly clientSummary?: ClientSummary | 'fail' | 'pending';
  /**
   * B09 — the Activity read of the project and of the client: the first page, or a function of the
   * query string (so a test can answer filters and "Load more").
   */
  readonly activity?:
    ActivityPage | 'fail' | 'pending' | ((search: URLSearchParams) => ActivityPage);
  /** B09 — the caller's capabilities from `…/me`; finance access by default. */
  readonly capabilities?: readonly string[];
}

function summaryReply(
  value: ProjectSummary | ClientSummary | ActivityPage | 'fail' | 'pending',
): Promise<Response> {
  if (value === 'pending') return new Promise<Response>(() => undefined);
  if (value === 'fail') {
    return reply(
      { error: { code: 'internal', message: 'Something went wrong.', correlationId: 'c' } },
      500,
    );
  }
  return reply(value);
}

/**
 * An `ApiClient` answering the reads both one-page screens make; nothing reaches a network.
 * `requests` records each path so a test can count the summary reads.
 */
export function overviewClient(routes: OverviewRoutes, requests: string[] = []): ApiClient {
  const fetch = ((input: RequestInfo | URL) => {
    const url = new URL(typeof input === 'string' ? input : input.toString());
    const path = url.pathname.replace('/v1/organizations/northstar', '');
    requests.push(`${path}${url.search}`);
    if (path === '/projects/proj-1/summary') {
      return summaryReply(routes.projectSummary ?? PROJECT_SUMMARY);
    }
    if (path === '/client-organizations/co-cedar/summary') {
      return summaryReply(routes.clientSummary ?? CLIENT_SUMMARY);
    }
    if (
      path === '/projects/proj-1/activity' ||
      path === '/client-organizations/co-cedar/activity'
    ) {
      const activity =
        routes.activity ?? ((search) => (search.get('cursor') ? ACTIVITY_PAGE_2 : ACTIVITY_PAGE));
      return summaryReply(typeof activity === 'function' ? activity(url.searchParams) : activity);
    }
    if (path === '/me') {
      return reply({
        membershipId: 'm-1',
        userId: 'user-1',
        kind: 'internal',
        role: 'owner',
        capabilities: routes.capabilities ?? ['work.read', 'finance.view', 'org.manage'],
        overrides: {},
        supportSession: null,
      });
    }
    if (path === '/projects/proj-1') return reply(PROJECT);
    if (path === '/members') return reply(MEMBERS);
    if (path === '/client-organizations/co-cedar') return reply(CLIENT_ORGANIZATION);
    if (path === '/client-memberships') return reply({ clientMemberships: [] });
    if (path === '/client-organizations/co-cedar/invitations') return reply({ invitations: [] });
    if (path === '/client-organizations/co-cedar/projects') {
      return reply({
        projects: [
          { id: 'proj-1', name: 'Cedar Foods brand refresh', status: 'active', sharedAt: '' },
          { id: 'proj-2', name: 'Ramadan campaign 2027', status: 'active', sharedAt: '' },
          { id: 'proj-3', name: 'Shelf talkers', status: 'active', sharedAt: '' },
        ],
      });
    }
    return reply({});
  }) as typeof globalThis.fetch;

  return new ApiClient({
    baseUrl: 'https://api.example.test',
    csrfCookieName: 'tm_session_csrf',
    fetch,
    readCsrfToken: () => undefined,
    newCorrelationId: () => 'correlation-story',
  });
}
