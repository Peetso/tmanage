import { ApiClient } from '../../src/lib/api/client';
import type { HomeSummary, MyDay, Waiting } from '../../src/lib/api/home';
import type { WorkItemSummary } from '../../src/lib/api/work-items';

/**
 * **My Day v3.1 busy seed** — the data of Figma 823:1312 (EN) and 824:322 (AR): seven open tasks
 * (two late, one due today, three due this week), three things waiting on the person and two on
 * others, three meetings and a focus block today, a timer at 00:42 on the Next task, a briefing,
 * the pricing question, and Saved / Pinned / Recent. One handler answers both the screen's own
 * client and the shell's browser client, so the title row and the page read the same day.
 */

/** Sunday 22 November 2026, 11:24 local: "Now 11:24" in the Today strip. */
export const MY_DAY_NOW = new Date(2026, 10, 22, 11, 24, 0).getTime();

const at = (dayOffset: number, hour: number, minute = 0): string =>
  new Date(2026, 10, 22 + dayOffset, hour, minute, 0).toISOString();

type Lang = 'en' | 'ar';
const words = (lang: Lang, en: string, ar: string) => (lang === 'ar' ? ar : en);

const PROJECTS = [
  { id: 'p-atlas', name: 'Atlas' },
  { id: 'p-meridian', name: 'Meridian' },
  { id: 'p-northstar', name: 'Northstar' },
  { id: 'p-harbour', name: 'Harbour Rebrand' },
] as const;

function task(id: string, projectId: string, title: string, dueAt: string | null): WorkItemSummary {
  return {
    id,
    projectId,
    type: 'task',
    title,
    state: 'in_progress',
    ownerUserId: 'user-1',
    audience: 'client_visible',
    startAt: null,
    dueAt,
    completedAt: null,
    version: 3,
    createdAt: at(-14, 9),
    updatedAt: at(-1, 16),
    deletedAt: null,
  };
}

function seed(lang: Lang) {
  const w = (en: string, ar: string) => words(lang, en, ar);
  const myDay: MyDay = {
    items: [
      {
        reason: 'overdue',
        workItem: task(
          'w-homepage',
          'p-atlas',
          w('Homepage concept v2', 'مفهوم الصفحة الرئيسية v2'),
          at(-3, 17),
        ),
      },
      {
        reason: 'overdue',
        workItem: task(
          'w-nav',
          'p-atlas',
          w('Navigation redesign', 'إعادة تصميم التنقل'),
          at(-1, 17),
        ),
      },
      {
        reason: 'due_soon',
        workItem: task(
          'w-booking',
          'p-atlas',
          w('Prepare mobile booking flow', 'تجهيز مسار الحجز للجوال'),
          at(0, 17),
        ),
      },
      {
        reason: 'due_soon',
        workItem: task(
          'w-faq',
          'p-meridian',
          w('Arabic FAQ copy', 'نصوص الأسئلة الشائعة بالعربية'),
          at(2, 17),
        ),
      },
      {
        reason: 'due_soon',
        workItem: task(
          'w-guide',
          'p-northstar',
          w('Brand guide pages', 'صفحات دليل العلامة'),
          at(4, 17),
        ),
      },
      {
        reason: 'due_soon',
        workItem: task('w-footer', 'p-atlas', w('Footer links', 'روابط التذييل'), at(5, 17)),
      },
      {
        reason: 'assigned',
        workItem: task('w-sitemap', 'p-atlas', w('Sitemap v3', 'خريطة الموقع v3'), null),
      },
    ],
  };
  const waiting: Waiting = {
    items: [
      {
        kind: 'approval',
        reason: 'approval_requested',
        approvalId: 'ap-booking',
        deliverableId: 'dl-booking',
        projectId: 'p-atlas',
        requestedAt: at(-2, 11, 24),
        deliverableTitle: w('Booking flow', 'مسار الحجز'),
        versionNo: 2,
        version: 1,
      },
      {
        kind: 'client_request',
        reason: 'client_triage',
        clientRequestId: 'cr-group',
        projectId: 'p-atlas',
        title: w('Group bookings question', 'سؤال الحجوزات الجماعية'),
        waitingSince: at(-1, 11, 24),
      },
      {
        kind: 'client_request',
        reason: 'client_submitted',
        clientRequestId: 'cr-assets',
        projectId: 'p-northstar',
        title: w('Brand assets request', 'طلب ملفات العلامة'),
        waitingSince: at(0, 8, 24),
      },
      {
        kind: 'client_request',
        reason: 'stale_follow_up',
        clientRequestId: 'cr-harbour-copy',
        projectId: 'p-harbour',
        title: w('Final copy sign-off', 'اعتماد النصوص النهائية'),
        waitingSince: at(-4, 10),
      },
      {
        kind: 'client_request',
        reason: 'stale_follow_up',
        clientRequestId: 'cr-harbour-photos',
        projectId: 'p-harbour',
        title: w('Product photos', 'صور المنتجات'),
        waitingSince: at(-3, 15),
      },
    ],
  };
  const summary: HomeSummary = {
    personalWork: { total: 7, overdue: 2, dueSoon: 4 },
    waiting: { total: 5, approvals: 1, clientRequests: 4, staleFollowUps: 2 },
  };
  const documents: Record<string, { title: string; projectId: string }> = {
    'doc-brief': { title: w('Homepage brief', 'موجز الصفحة الرئيسية'), projectId: 'p-atlas' },
    'doc-launch': { title: w('Launch checklist', 'قائمة الإطلاق'), projectId: 'p-atlas' },
    'doc-rates': { title: w('Rate card 2026', 'بطاقة الأسعار 2026'), projectId: 'p-northstar' },
    'doc-sitemap': { title: w('Sitemap v3', 'خريطة الموقع v3'), projectId: 'p-atlas' },
  };
  const meetings: Record<string, { title: string; projectId: string; startsAt: string }> = {
    'mt-standup': {
      title: w('Standup', 'الاجتماع اليومي'),
      projectId: 'p-atlas',
      startsAt: at(0, 9, 30),
    },
    'mt-review': {
      title: w('Atlas design review', 'مراجعة تصميم Atlas'),
      projectId: 'p-atlas',
      startsAt: at(0, 11),
    },
    'mt-approval': {
      title: w('Client approval call', 'مكالمة اعتماد العميل'),
      projectId: 'p-meridian',
      startsAt: at(0, 11, 45),
    },
    'mt-weekly': {
      title: w('Atlas weekly update', 'التحديث الأسبوعي لـ Atlas'),
      projectId: 'p-atlas',
      startsAt: at(-1, 10),
    },
  };
  const invoice = task('w-invoice', 'p-meridian', 'INV-0142', null);
  return {
    myDay,
    waiting,
    summary,
    documents,
    meetings,
    invoice,
    focus: w('Homepage', 'الصفحة الرئيسية'),
  };
}

function reply(body: unknown, status = 200): Promise<Response> {
  return Promise.resolve(
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }),
  );
}

export interface MyDaySeedOptions {
  readonly lang?: Lang;
  /** `empty`: a new member with nothing yet (every widget collapses to its one line). */
  readonly variant?: 'busy' | 'empty';
}

/** The fetch both clients use: answers every read the page and its title row make. */
export function myDayFetch({ lang = 'en', variant = 'busy' }: MyDaySeedOptions = {}) {
  const data = seed(lang);
  const empty = variant === 'empty';
  const work = new Map<string, WorkItemSummary>(
    [...data.myDay.items.map((entry) => entry.workItem), data.invoice].map((item) => [
      item.id,
      item,
    ]),
  );
  return ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
      'http://story.test',
    );
    const marker = '/v1/organizations/northstar';
    const index = url.pathname.indexOf(marker);
    const path = index < 0 ? url.pathname : url.pathname.slice(index + marker.length);
    const method = (init?.method ?? 'GET').toUpperCase();
    if (method !== 'GET') return reply({});
    switch (path) {
      case '/home/my-day':
        return reply(empty ? { items: [] } : data.myDay);
      case '/home/waiting':
        return reply(empty ? { items: [] } : data.waiting);
      case '/home/summary':
        return reply(
          empty
            ? {
                personalWork: { total: 0, overdue: 0, dueSoon: 0 },
                waiting: { total: 0, approvals: 0, clientRequests: 0, staleFollowUps: 0 },
              }
            : data.summary,
        );
      case '/projects':
        return reply({
          projects: (empty ? [] : PROJECTS).map((project) => ({
            ...project,
            workspaceId: 'ws-1',
            status: 'active',
            ownerUserId: 'user-1',
            committedAt: null,
            forecastAt: null,
            createdAt: at(-60, 9),
            updatedAt: at(-1, 9),
            archivedAt: null,
          })),
        });
      case '/home/widget-prefs':
        return reply({ order: [], hidden: [] });
      case '/meetings/grid':
        return reply({
          range: 'week',
          anchor: '2026-11-22',
          from: '2026-11-22',
          to: '2026-11-28',
          days: [
            {
              date: '2026-11-22',
              occurrences: [],
              meetings: empty
                ? []
                : ['mt-standup', 'mt-review', 'mt-approval'].map((id) => ({
                    id,
                    projectId: data.meetings[id]?.projectId,
                    title: data.meetings[id]?.title,
                    startsAt: data.meetings[id]?.startsAt,
                  })),
            },
          ],
        });
      case '/calendar/focus-blocks':
        return reply({
          blocks: empty
            ? []
            : [
                {
                  id: 'fb-1',
                  startsAt: at(0, 16),
                  endsAt: at(0, 17),
                  title: data.focus,
                  createdAt: at(-1, 9),
                },
              ],
        });
      case '/v1/organizations':
        return reply({
          organizations: [
            {
              id: 'org-1',
              slug: 'northstar',
              name: 'Atlas Studio',
              audience: 'internal',
              role: 'owner',
              clientOrganizationName: null,
            },
          ],
        });
      case '/time/timer':
        return reply({
          timer: empty
            ? null
            : {
                id: 'tm-1',
                workItemId: 'w-homepage',
                projectId: 'p-atlas',
                note: null,
                billable: true,
                startedAt: at(0, 10, 42),
                lastHeartbeatAt: at(0, 11, 23),
                elapsedSeconds: 42 * 60 + 2,
              },
          serverNow: at(0, 11, 24),
          roundingMinutes: 1,
        });
      case '/time/timesheets/mine':
        return reply({
          id: 'ts-1',
          membershipId: 'm-1',
          periodStart: '2026-11-16',
          periodEnd: '2026-11-22',
          days: [],
          state: 'open',
          version: 1,
          decisionNote: null,
          totalMinutes: empty ? 0 : 158,
          billableMinutes: empty ? 0 : 158,
          locked: false,
          groups: empty
            ? []
            : [
                {
                  projectId: 'p-atlas',
                  workItemId: 'w-nav',
                  title: null,
                  minutes: 158,
                  entries: [
                    {
                      id: 'te-1',
                      title: null,
                      spentOn: '2026-11-22',
                      minutes: 158,
                      billable: true,
                      needsReview: false,
                      source: 'timer',
                    },
                  ],
                },
              ],
        });
      case '/time/auto':
        return reply({
          policy: 'optional',
          enabled: false,
          ownSwitch: false,
          idleThresholdMinutes: 5,
          maxIdleMinutes: 30,
          currentTask: null,
          session: null,
          manualTimerRunning: !empty,
          visibleTo: 'admins_and_authorized',
          serverNow: at(0, 11, 24),
        });
      case '/getting-started':
        return reply({
          dismissed: false,
          completedCount: empty ? 1 : 3,
          totalCount: 6,
          nextStep: 'invite_teammate',
          steps: [
            { step: 'create_project', done: !empty },
            { step: 'add_client', done: !empty },
            { step: 'set_working_hours', done: true },
            { step: 'invite_teammate', done: false },
            { step: 'connect_storage', done: false },
            { step: 'try_ai_assistant', done: false },
          ],
        });
      case '/home/briefing':
        return reply(
          empty
            ? { audience: 'company', asOf: at(0, 10), groups: [] }
            : {
                audience: 'company',
                asOf: at(0, 10),
                groups: [
                  { group: 'projects_at_risk', count: 4, lines: [], more: 0, path: '/insights' },
                  { group: 'waiting_on_clients', count: 5, lines: [], more: 0, path: '/insights' },
                  { group: 'stale_work', count: 3, lines: [], more: 0, path: '/insights' },
                  { group: 'money_to_collect', count: 2, lines: [], more: 0, path: '/finance' },
                ],
              },
        );
      case '/pricing-survey':
        return reply({ show: true });
      case '/home/saved-context':
        return reply({
          groups: empty
            ? []
            : [
                {
                  projectId: 'p-atlas',
                  items: [
                    { id: 's-1', entityType: 'doc', entityId: 'doc-brief', createdAt: at(-1, 9) },
                  ],
                },
                {
                  projectId: 'p-meridian',
                  items: [
                    { id: 's-2', entityType: 'message', entityId: 'msg-1', createdAt: at(-2, 9) },
                  ],
                },
                {
                  projectId: 'p-northstar',
                  items: [
                    { id: 's-3', entityType: 'file', entityId: 'file-1', createdAt: at(-3, 9) },
                  ],
                },
                {
                  projectId: 'p-atlas',
                  items: [
                    { id: 's-4', entityType: 'doc', entityId: 'doc-launch', createdAt: at(-6, 9) },
                    { id: 's-5', entityType: 'work', entityId: 'w-sitemap', createdAt: at(-7, 9) },
                  ],
                },
              ],
        });
      case '/home/pins':
        return reply({
          pins: empty
            ? []
            : [
                { id: 'pin-1', targetKind: 'project', targetId: 'p-atlas', createdAt: at(-5, 9) },
                {
                  id: 'pin-2',
                  targetKind: 'document',
                  targetId: 'doc-launch',
                  createdAt: at(-4, 9),
                },
                {
                  id: 'pin-3',
                  targetKind: 'document',
                  targetId: 'doc-rates',
                  createdAt: at(-3, 9),
                },
              ],
        });
      case '/home/recent-items':
        return reply({
          items: empty
            ? []
            : [
                {
                  id: 'r-1',
                  objectType: 'document',
                  objectId: 'doc-sitemap',
                  viewedAt: at(0, 11, 2),
                },
                {
                  id: 'r-2',
                  objectType: 'meeting',
                  objectId: 'mt-weekly',
                  viewedAt: at(0, 10, 40),
                },
                { id: 'r-3', objectType: 'work', objectId: 'w-invoice', viewedAt: at(0, 9, 15) },
              ],
        });
      case '/feature-flags':
        return reply({ flags: { time_tracking: true } });
      case '/me':
        return reply({
          membershipId: 'm-1',
          userId: 'user-1',
          kind: 'internal',
          role: 'owner',
          capabilities: ['work.read', 'finance.view', 'org.manage'],
          overrides: {},
          supportSession: null,
        });
      default:
        break;
    }
    const [, kind, id] = path.split('/');
    if (kind === 'projects' && id) {
      const project = PROJECTS.find((candidate) => candidate.id === id);
      return project ? reply(project) : reply({}, 404);
    }
    if (kind === 'work-items' && id) {
      const item = work.get(id);
      return item ? reply(item) : reply({}, 404);
    }
    if (kind === 'documents' && id) {
      const doc = data.documents[id];
      return doc ? reply({ id, ...doc }) : reply({}, 404);
    }
    if (kind === 'meetings' && id && path.endsWith('/overview')) {
      const meeting = data.meetings[id];
      return meeting ? reply({ meeting: { id, ...meeting } }) : reply({}, 404);
    }
    return reply({});
  }) as typeof globalThis.fetch;
}

export function myDayClient(options: MyDaySeedOptions = {}): ApiClient {
  return new ApiClient({
    baseUrl: 'https://api.example.test',
    csrfCookieName: 'tm_session_csrf',
    fetch: myDayFetch(options),
    readCsrfToken: () => undefined,
    newCorrelationId: () => 'correlation-story',
  });
}

/**
 * Story `beforeEach`: the shell's own reads (Help, AI, the timer capsule, + New) go through the
 * browser client and the global fetch, so the same seed answers them too.
 */
export function installMyDayFetch(options: MyDaySeedOptions = {}): () => void {
  const original = globalThis.fetch;
  const seeded = myDayFetch(options);
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    return href.includes('/v1/') ? seeded(input, init) : original(input, init);
  }) as typeof globalThis.fetch;
  return () => {
    globalThis.fetch = original;
  };
}
