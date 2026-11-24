import { ApiClient } from '../../src/lib/api/client';
import type {
  AiEmployeeConnectionListView,
  AiEmployeeConnectionView,
  AiEmployeeListView,
  AiEmployeeSettingsView,
  AiEmployeeView,
  AiExcludedProjectListView,
  CreatedAgentKeyView,
} from '../../src/lib/api/ai-employees';
import type { PersonSummary } from '../../src/lib/api/people';

/**
 * The AI employees designs' workspace (plan 60, `ai-employees-figma/AI-S1…S8`), for the 60-07
 * stories: Peter Kamal owns it; Mat, Nour and Rami are AI employees. Every read the People page,
 * the hire wizard, the AI employee profile and Settings › AI employees make is answered here, and
 * nothing reaches a network. Names are data, so the Arabic cast is the Arabic designs' (زياد for
 * Mat).
 */

/** The designs' clock: "4 min ago", "in 58 days" are measured from here. */
export const AI_NOW = Date.parse('2026-11-24T10:00:00.000Z');
const minutesAgo = (minutes: number) => new Date(AI_NOW - minutes * 60_000).toISOString();
const daysFromNow = (days: number) => new Date(AI_NOW + days * 86_400_000).toISOString();

export interface AiCast {
  readonly people: readonly (readonly [id: string, name: string, role: string, job: string])[];
  readonly mat: readonly [string, string];
  readonly nour: readonly [string, string];
  readonly rami: readonly [string, string];
  readonly projects: readonly (readonly [id: string, name: string, client: boolean])[];
}

export const AI_CAST_EN: AiCast = {
  people: [
    ['laila', 'Laila Hassan', 'member', 'Account manager'],
    ['mona', 'Mona Rashad', 'member', 'Designer'],
    ['peter', 'Peter Kamal', 'owner', 'Founder'],
    ['sara', 'Sara Adel', 'org_admin', 'Project manager'],
    ['youssef', 'Youssef Tarek', 'member', 'Developer'],
  ],
  mat: ['Mat', 'Social media designer'],
  nour: ['Nour', 'Copywriter'],
  rami: ['Rami', 'Research assistant'],
  projects: [
    ['p-web', 'Website relaunch', false],
    ['p-nile', 'Nile Foods social', true],
    ['p-brand', 'Brand refresh', false],
    ['p-payroll', 'Payroll 2026', false],
    ['p-legal', 'Legal: Nile Foods contract', true],
    ['p-app', 'Mobile app', false],
  ],
};

export const AI_CAST_AR: AiCast = {
  people: [
    ['laila', 'ليلى حسن', 'member', 'مديرة حسابات'],
    ['mona', 'منى رشاد', 'member', 'مصممة'],
    ['peter', 'بيتر كمال', 'owner', 'المؤسس'],
    ['sara', 'سارة عادل', 'org_admin', 'مديرة مشاريع'],
    ['youssef', 'يوسف طارق', 'member', 'مطوّر'],
  ],
  mat: ['زياد', 'مصمم سوشيال ميديا'],
  nour: ['نور', 'كاتبة محتوى'],
  rami: ['رامي', 'مساعد أبحاث'],
  projects: [
    ['p-web', 'إعادة إطلاق الموقع', false],
    ['p-nile', 'سوشيال نايل فودز', true],
    ['p-brand', 'تجديد البراند', false],
    ['p-payroll', 'المرتبات 2026', false],
    ['p-legal', 'قانوني: عقد نايل فودز', true],
    ['p-app', 'تطبيق الموبايل', false],
  ],
};

export function aiPeople(cast: AiCast): readonly PersonSummary[] {
  return cast.people.map(([id, name, role, job], index) => ({
    userId: `u-${id}`,
    membershipId: `m-${id}`,
    displayName: name,
    email: `${id}@northstar.studio`,
    role,
    roleName: null,
    status: 'active',
    projectCount: 2 + index,
    version: 1,
    lastActiveAt: minutesAgo(60 * (index + 1)),
    teams: [],
    openCommitments: 0,
    overdueCommitments: 0,
    declared: null,
    // The manager adds `jobTitle` to PersonSummary with 60-07's API change; the screen reads it safely.
    jobTitle: job,
  })) as readonly PersonSummary[];
}

function sponsorOf(cast: AiCast, id: string) {
  const person = cast.people.find((entry) => entry[0] === id);
  return { membershipId: `m-${id}`, displayName: person ? person[1] : null };
}

function projectsOf(cast: AiCast, ids: readonly string[]) {
  return ids.map((id) => {
    const project = cast.projects.find((entry) => entry[0] === id);
    return { id, name: project ? project[1] : id, isClient: project ? project[2] : false };
  });
}

/** One AI employee view; the S6 Mat by default. */
export function aiView(cast: AiCast, overrides: Partial<AiEmployeeView> = {}): AiEmployeeView {
  return {
    id: 'ai-mat',
    membershipId: 'm-mat',
    userId: 'u-mat',
    displayName: cast.mat[0],
    role: 'member',
    jobTitle: cast.mat[1],
    departmentKey: 'marketing',
    vendorLabel: 'Claude',
    modelLabel: null,
    status: 'active',
    pausedReason: null,
    pausedAt: null,
    retiredAt: null,
    sponsor: sponsorOf(cast, 'peter'),
    timezone: 'Africa/Cairo',
    workingHours: [0, 1, 2, 3, 4].map((day) => ({ day, start: '09:00', end: '17:00' })),
    limits: {
      callsPerMinute: 60,
      writesPerDay: 200,
      openAssignments: 5,
      questionRounds: 2,
      questionsPerRound: 5,
      attemptsPerRound: 2,
      revisionRounds: 2,
    },
    discloseToClients: true,
    projects: projectsOf(cast, ['p-web', 'p-nile', 'p-brand']),
    taskTypes: [],
    connection: { live: 2, lastCalledAt: minutesAgo(4) },
    version: 3,
    createdAt: minutesAgo(60 * 24 * 30),
    updatedAt: minutesAgo(60),
    canEdit: true,
    canPause: true,
    canResume: true,
    canRetire: true,
    ...overrides,
  };
}

export type AiScene = 'normal' | 'empty' | 'retired' | 'off' | 'limit';

export function aiList(cast: AiCast, scene: AiScene = 'normal'): AiEmployeeListView {
  if (scene === 'empty')
    return { aiEmployees: [], limit: 5, live: 0, canHire: true, enabled: true };
  const mat = aiView(
    cast,
    scene === 'retired'
      ? {
          status: 'retired',
          retiredAt: minutesAgo(60),
          connection: { live: 0, lastCalledAt: null },
        }
      : {},
  );
  const nour = aiView(cast, {
    id: 'ai-nour',
    membershipId: 'm-nour',
    userId: 'u-nour',
    displayName: cast.nour[0],
    jobTitle: cast.nour[1],
    sponsor: sponsorOf(cast, 'sara'),
    connection: { live: 0, lastCalledAt: null },
    projects: projectsOf(cast, ['p-web']),
  });
  const rami = aiView(cast, {
    id: 'ai-rami',
    membershipId: 'm-rami',
    userId: 'u-rami',
    displayName: cast.rami[0],
    jobTitle: cast.rami[1],
    role: 'guest',
    status: 'paused',
    pausedReason: 'manual',
    pausedAt: minutesAgo(120),
    projects: projectsOf(cast, ['p-brand']),
  });
  const extra =
    scene === 'limit'
      ? [
          aiView(cast, {
            id: 'ai-hana',
            membershipId: 'm-hana',
            displayName: 'Hana',
            jobTitle: 'Analyst',
          }),
          aiView(cast, {
            id: 'ai-omar',
            membershipId: 'm-omar',
            displayName: 'Omar',
            jobTitle: 'Editor',
          }),
        ]
      : [];
  const aiEmployees = [mat, nour, rami, ...extra];
  return {
    aiEmployees,
    limit: 5,
    live: scene === 'retired' ? 2 : aiEmployees.length,
    canHire: scene !== 'limit' && scene !== 'off',
    enabled: scene !== 'off',
  };
}

export function aiConnections(
  cast: AiCast,
  connections: 'two' | 'none' = 'two',
): AiEmployeeConnectionListView {
  const peter = sponsorOf(cast, 'peter');
  const rows: AiEmployeeConnectionView[] = [
    {
      id: 'grant-claude',
      kind: 'connector',
      name: 'Claude connector',
      tokenPrefix: null,
      addedBy: peter,
      createdAt: minutesAgo(60 * 24 * 3),
      lastUsedAt: minutesAgo(4),
      expiresAt: null,
      live: true,
    },
    {
      id: 'key-1',
      kind: 'key',
      name: 'Agent key',
      tokenPrefix: 'tm_agent_k9Xw',
      addedBy: peter,
      createdAt: minutesAgo(60 * 24 * 32),
      lastUsedAt: minutesAgo(120),
      expiresAt: daysFromNow(58),
      live: true,
    },
  ];
  const list = connections === 'none' ? [] : rows;
  return { connections: list, limit: 3, live: list.length, canCreate: true };
}

export const ROTATED_KEY: CreatedAgentKeyView = {
  id: 'key-2',
  name: 'Agent key',
  tokenPrefix: 'tm_agent_Q8mz',
  createdAt: new Date(AI_NOW).toISOString(),
  expiresAt: daysFromNow(90),
  lastUsedAt: null,
  revokedAt: null,
  createdByMembershipId: 'm-peter',
  ipAllowlist: [],
  live: true,
  token: 'tm_agent_Q8mzV1n2Rk7pL0aX3RtL',
};

export function aiSettings(enabled = true): AiEmployeeSettingsView {
  return {
    enabled,
    hirePolicy: 'owners_and_admins',
    assignPolicy: 'managers',
    clientWork: 'allowed',
    discloseToClients: true,
    secondApprover: true,
    version: 4,
    limit: 5,
    live: 3,
    canEdit: true,
  };
}

export function aiExcluded(cast: AiCast): AiExcludedProjectListView {
  const name = (id: string) => cast.projects.find((entry) => entry[0] === id)?.[1] ?? id;
  return {
    projects: [
      {
        projectId: 'p-payroll',
        name: name('p-payroll'),
        setByMembershipId: 'm-sara',
        createdAt: '2026-11-12T09:00:00.000Z',
      },
      {
        projectId: 'p-legal',
        name: name('p-legal'),
        setByMembershipId: 'm-peter',
        createdAt: '2026-11-03T09:00:00.000Z',
      },
    ],
    canEdit: true,
  };
}

export interface AiClientOptions {
  readonly cast: AiCast;
  readonly scene?: AiScene;
  readonly connections?: 'two' | 'none';
  /** The AI employee the wizard's test step polls (S4c–e). */
  readonly polled?: AiEmployeeView;
  /** `false`: every AI employees read answers 404 (the feature is off for this workspace). */
  readonly aiOffered?: boolean;
  /** Tests: every write the screen sends, with its body. */
  readonly onWrite?: (write: { method: string; path: string; body: unknown }) => void;
  /** Tests: answer one write with this status instead (e.g. 409 for a stale version). */
  readonly failWrites?: number;
}

function reply(body: unknown, status = 200): Response {
  return new Response(status === 204 ? null : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** Every read of the 60-07 screens, routed on the path; writes answer with the read they change. */
export function aiEmployeesClient(options: AiClientOptions): ApiClient {
  const { cast, scene = 'normal', connections = 'two', aiOffered = true } = options;
  const list = aiList(cast, scene);
  const notFound = () =>
    reply({ error: { code: 'not_found', message: 'Not found', correlationId: 'c' } }, 404);
  const route = (url: URL, method: string): Response => {
    const path = url.pathname;
    if (path.includes('/ai-employees')) {
      if (!aiOffered) return notFound();
      if (path.endsWith('/ai-employees/settings')) return reply(aiSettings(scene !== 'off'));
      if (path.includes('/ai-employees/excluded-projects')) return reply(aiExcluded(cast));
      if (path.endsWith('/connections')) return reply(aiConnections(cast, connections));
      if (path.endsWith('/rotate')) return reply(ROTATED_KEY);
      if (path.endsWith('/keys') && method === 'POST') return reply(ROTATED_KEY);
      if (path.endsWith('/ai-employees') && method === 'POST')
        return reply(options.polled ?? aiView(cast));
      if (path.endsWith('/ai-employees')) return reply(list);
      if (/\/(pause|resume|retire|sponsor)$/.test(path))
        return reply(options.polled ?? aiView(cast));
      const id = decodeURIComponent(path.split('/').pop() ?? '');
      const found = options.polled ?? list.aiEmployees.find((entry) => entry.id === id);
      return found ? reply(found) : notFound();
    }
    if (path.endsWith('/people')) return reply({ people: aiPeople(cast), nextAfter: null });
    if (path.endsWith('/me')) {
      return reply({
        membershipId: 'm-peter',
        userId: 'u-peter',
        kind: 'internal',
        role: 'owner',
        capabilities: [],
        overrides: {},
        supportSession: null,
      });
    }
    if (path.includes('/projects/portfolio')) {
      return reply({
        projects: cast.projects.map(([projectId, name, client]) => ({
          projectId,
          name,
          clientName: client ? 'Nile Foods' : null,
          archivedAt: null,
        })),
      });
    }
    if (path.endsWith('/admin/invitations')) return reply({ invitations: [] });
    if (path.endsWith('/admin/roles')) return reply({ roles: [] });
    return notFound();
  };
  return new ApiClient({
    baseUrl: 'https://api.example.test',
    csrfCookieName: 'tm_session_csrf',
    fetch: ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      const method = (init?.method ?? 'GET').toUpperCase();
      if (method !== 'GET') {
        const body =
          typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined;
        options.onWrite?.({ method, path: url.pathname, body });
        if (options.failWrites !== undefined) {
          return Promise.resolve(
            reply(
              { error: { code: 'conflict', message: 'Stale', correlationId: 'c' } },
              options.failWrites,
            ),
          );
        }
        if (method === 'DELETE' && !url.pathname.includes('excluded-projects')) {
          return Promise.resolve(reply(null, 204));
        }
      }
      return Promise.resolve(route(url, method));
    }) as typeof globalThis.fetch,
    readCsrfToken: () => 'csrf-story',
    newCorrelationId: () => 'correlation-story',
  });
}
