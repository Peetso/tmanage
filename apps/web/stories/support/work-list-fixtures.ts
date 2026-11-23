import { ApiClient } from '../../src/lib/api/client';
import { DESIGN_SET, WORK_NOW } from './work-fixtures';

/**
 * Work area v2 (W-WEB-2) — the Works list and board reads, filled the way Figma `WV2-01 Works
 * list` (`930:95062`) and `WV2-10 Board` (`939:101782`) draw them: ten works across three
 * projects, several doers, a supervisor, a client or "Internal", and a stage from each project's
 * set. Every write answers with an empty 200, so pressing a control never reaches a network.
 */
export { WORK_NOW };

const ORG = '/v1/organizations/northstar';
const HOUR = 3_600_000;

const USERS = [
  ['u-peter', 'Peter Kamal'],
  ['u-sara', 'Sara Adel'],
  ['u-mona', 'Mona Rizk'],
  ['u-laila', 'Laila Hassan'],
  ['u-youssef', 'Youssef Tarek'],
  ['u-omar', 'Omar Mahmoud'],
].map(([userId, displayName], index) => ({
  userId,
  displayName,
  role: index === 3 ? 'manager' : 'member',
  membershipId: `m-${index}`,
}));

const CLIENTS = [
  { id: 'c-nile', name: 'Nile Foods' },
  { id: 'c-cairo', name: 'Cairo Bikes' },
  { id: 'c-delta', name: 'Delta Pharma' },
];

const PROJECTS = [
  { id: 'proj-1', name: 'Website relaunch', status: 'active' },
  { id: 'proj-2', name: 'Brand refresh', status: 'active' },
  { id: 'proj-3', name: 'Mobile app', status: 'active' },
];

const TEAMS = [
  ['t-design', 'Design', ['u-sara', 'u-mona', 'u-youssef']],
  ['t-dev', 'Development', ['u-omar', 'u-peter']],
  ['t-cs', 'Client success', ['u-laila']],
] as const;

function stage(id: string, name: string, stateKey: string, group: string, position: number) {
  return { id, name, stateKey, group, colorKey: null, position };
}

/** Brand refresh and Mobile app use the workspace's simple set. */
export const SIMPLE_SET = {
  ...DESIGN_SET,
  id: 'set-simple',
  name: 'Simple',
  isDefault: true,
  stages: [
    stage('st-todo', 'To do', 'ready', 'not_started', 0),
    stage('st-doing', 'In progress', 'in_progress', 'in_progress', 1),
    stage('st-review', 'In review', 'internal_review', 'in_review', 2),
    stage('st-closed', 'Done', 'done', 'done', 3),
  ],
};

type Row = readonly [
  id: string,
  title: string,
  projectId: string,
  state: string,
  stageId: string,
  stageName: string,
  doers: readonly string[],
  supervisors: readonly string[],
  due: string,
  clients: readonly string[],
  /** Hours before {@link WORK_NOW}. */
  updatedHoursAgo: number,
];

/** The list frame's ten rows, in its order. */
const LIST_ROWS: readonly Row[] = [
  [
    'wi-1',
    'Design the landing page',
    'proj-1',
    'in_progress',
    'st-prototype',
    'Prototype',
    ['u-peter', 'u-sara', 'u-mona'],
    ['u-laila'],
    '2026-12-01',
    ['c-nile'],
    2,
  ],
  [
    'wi-2',
    'Homepage copy review',
    'proj-2',
    'internal_review',
    'st-review',
    'In review',
    ['u-sara'],
    ['u-peter'],
    '2026-12-02',
    ['c-nile'],
    5,
  ],
  [
    'wi-3',
    'Wireframe the onboarding flow',
    'proj-1',
    'in_progress',
    'st-ideate',
    'Ideate',
    ['u-mona', 'u-youssef'],
    ['u-laila'],
    '2026-12-03',
    [],
    26,
  ],
  [
    'wi-4',
    'Brand colour audit',
    'proj-2',
    'ready',
    'st-todo',
    'To do',
    ['u-youssef'],
    [],
    '2026-12-04',
    ['c-cairo'],
    30,
  ],
  [
    'wi-5',
    'Set up analytics events',
    'proj-3',
    'in_progress',
    'st-doing',
    'In progress',
    ['u-omar', 'u-peter'],
    ['u-sara'],
    '2026-12-07',
    [],
    50,
  ],
  [
    'wi-6',
    'Client kickoff deck',
    'proj-1',
    'done',
    'st-done',
    'Done',
    ['u-laila'],
    ['u-peter'],
    '2026-11-27',
    ['c-cairo'],
    74,
  ],
  [
    'wi-7',
    'App store screenshots',
    'proj-3',
    'ready',
    'st-todo',
    'To do',
    ['u-mona'],
    [],
    '2026-12-09',
    ['c-delta'],
    76,
  ],
  [
    'wi-8',
    'Invoice template update',
    'proj-2',
    'internal_review',
    'st-review',
    'In review',
    ['u-omar'],
    ['u-laila'],
    '2026-12-10',
    [],
    98,
  ],
  [
    'wi-9',
    'Usability test, round 1',
    'proj-1',
    'internal_review',
    'st-test',
    'Test',
    ['u-sara', 'u-youssef', 'u-mona', 'u-omar'],
    ['u-peter'],
    '2026-12-11',
    ['c-delta'],
    122,
  ],
  [
    'wi-10',
    'Social launch calendar',
    'proj-2',
    'ready',
    'st-todo',
    'To do',
    ['u-peter'],
    [],
    '2026-12-14',
    ['c-nile'],
    170,
  ],
];

/** The board frame's Website relaunch works on the Design thinking stages, in its card order. */
const BOARD_ROWS: readonly (readonly [id: string, stageId: string, name: string, state: string])[] =
  [
    ['wi-4', 'st-empathize', 'Empathize', 'ready'],
    ['wi-10', 'st-empathize', 'Empathize', 'ready'],
    ['wi-7', 'st-define', 'Define', 'in_progress'],
    ['wi-3', 'st-ideate', 'Ideate', 'in_progress'],
    ['wi-1', 'st-prototype', 'Prototype', 'in_progress'],
    ['wi-5', 'st-prototype', 'Prototype', 'in_progress'],
    ['wi-9', 'st-test', 'Test', 'internal_review'],
    ['wi-6', 'st-done', 'Done', 'done'],
  ];

function toSummary(row: Row, index: number) {
  const [id, title, projectId, state, stageId, stageName, doers, supervisors, due, clients, hours] =
    row;
  return {
    id,
    projectId,
    type: 'task',
    title,
    description: null,
    state,
    ownerUserId: doers[0] ?? null,
    audience: clients.length > 0 ? 'client_visible' : 'internal',
    startAt: null,
    dueAt: `${due}T12:00:00.000Z`,
    completedAt: state === 'done' ? '2026-11-20T09:00:00.000Z' : null,
    version: 1,
    createdAt: '2026-11-10T09:00:00.000Z',
    updatedAt: new Date(WORK_NOW.getTime() - hours * HOUR).toISOString(),
    deletedAt: null,
    doerUserIds: doers,
    rank: index,
    stageId,
    stageName,
    supervisorUserIds: supervisors,
    clientOrganizationIds: clients,
  };
}

function boardRows(): Row[] {
  return BOARD_ROWS.map(([id, stageId, name, state]) => {
    const row = LIST_ROWS.find((candidate) => candidate[0] === id) as Row;
    return [row[0], row[1], 'proj-1', state, stageId, name, ...row.slice(6)] as unknown as Row;
  });
}

export type WorkListStoryMode = 'filled' | 'empty' | 'loading' | 'error' | 'offline';

function reply(body: unknown, status = 200): Promise<Response> {
  return Promise.resolve(
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    }),
  );
}

/** The Works list's reads by path; `mode` picks the state the list frame shows. */
export function workListClient(mode: WorkListStoryMode = 'filled'): ApiClient {
  const fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input.toString());
    const path = url.pathname.startsWith(ORG) ? url.pathname.slice(ORG.length) : url.pathname;
    if ((init?.method ?? 'GET') !== 'GET') return reply({});
    const team = TEAMS.find(([id]) => path === `/people/teams/${id}`);
    if (team) {
      const [id, name, members] = team;
      return reply({
        id,
        name,
        createdAt: '2026-10-01T00:00:00.000Z',
        members: members.map((userId) => ({
          membershipId: `m-${userId}`,
          userId,
          displayName: USERS.find((user) => user.userId === userId)?.displayName ?? userId,
          role: 'member',
          status: 'active',
          openWorkCount: 1,
        })),
      });
    }
    switch (path) {
      case '/work-items': {
        if (mode === 'loading') return new Promise<Response>(() => undefined);
        if (mode === 'error') {
          return reply({ error: { code: 'internal', message: 'Something broke.' } }, 500);
        }
        if (mode === 'offline') return Promise.reject(new TypeError('Failed to fetch'));
        if (mode === 'empty') return reply({ workItems: [] });
        const rows = url.searchParams.get('projectId') === 'proj-1' ? boardRows() : LIST_ROWS;
        return reply({ workItems: rows.map(toSummary) });
      }
      case '/me':
        return reply({
          membershipId: 'm-0',
          userId: 'u-peter',
          kind: 'internal',
          role: 'manager',
          capabilities: ['work.read', 'work.create', 'work.update', 'work.transition'],
          overrides: {},
          supportSession: null,
        });
      case '/projects':
        return reply({ projects: PROJECTS });
      case '/members':
        return reply({ members: USERS, nextAfter: null });
      case '/people/teams':
        return reply({
          teams: TEAMS.map(([id, name, members]) => ({
            id,
            name,
            memberCount: members.length,
            createdAt: '2026-10-01T00:00:00.000Z',
          })),
        });
      case '/client-organization-options':
        return reply({ clientOrganizations: CLIENTS });
      case '/work/stage-sets':
        return reply({ stageSets: [SIMPLE_SET, DESIGN_SET] });
      case '/projects/proj-1/stage-set':
        return reply({ source: 'workspace', stageSet: DESIGN_SET });
      case '/projects/proj-2/stage-set':
      case '/projects/proj-3/stage-set':
        return reply({ source: 'workspace', stageSet: SIMPLE_SET });
      default:
        return reply({ error: { code: 'not_found', message: 'Not in this story.' } }, 404);
    }
  }) as typeof globalThis.fetch;
  return new ApiClient({
    baseUrl: 'https://api.example.test',
    csrfCookieName: 'tm_session_csrf',
    readCsrfToken: () => undefined,
    newCorrelationId: () => 'correlation-story',
    fetch,
  });
}
