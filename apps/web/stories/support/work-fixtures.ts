import { ApiClient } from '../../src/lib/api/client';

/**
 * Work area v2 (W-WEB-1) — the work page's reads, filled the way Figma `WV2-02 Work page`
 * (`933:95423`) draws them: "Design the landing page" on the design-thinking stages, five steps
 * (two done), three doers, a supervisor, a client, two labels and four comments. Every write is
 * answered with the item itself, so pressing a control in a story never reaches a network.
 */
export const WORK_NOW = new Date('2026-11-23T09:00:00.000Z');

const ORG = '/v1/organizations/northstar';

const USERS = [
  { userId: 'u-peter', displayName: 'Peter Kamal', role: 'member', membershipId: 'm-peter' },
  { userId: 'u-sara', displayName: 'Sara Adel', role: 'member', membershipId: 'm-sara' },
  { userId: 'u-mona', displayName: 'Mona Rizk', role: 'member', membershipId: 'm-mona' },
  { userId: 'u-laila', displayName: 'Laila Hassan', role: 'manager', membershipId: 'm-laila' },
] as const;

function stage(id: string, name: string, stateKey: string, group: string, position: number) {
  return { id, name, stateKey, group, colorKey: null, position };
}

export const DESIGN_SET = {
  id: 'set-design',
  name: 'Design thinking',
  scope: 'workspace',
  projectId: null,
  isDefault: false,
  isBuiltIn: false,
  version: 1,
  stages: [
    stage('st-empathize', 'Empathize', 'ready', 'not_started', 0),
    stage('st-define', 'Define', 'in_progress', 'in_progress', 1),
    stage('st-ideate', 'Ideate', 'in_progress', 'in_progress', 2),
    stage('st-prototype', 'Prototype', 'in_progress', 'in_progress', 3),
    stage('st-test', 'Test', 'internal_review', 'in_review', 4),
    stage('st-done', 'Done', 'done', 'done', 5),
  ],
  createdAt: '2026-11-01T00:00:00.000Z',
  updatedAt: '2026-11-01T00:00:00.000Z',
};

const BUILT_IN_SET = {
  id: 'builtin',
  name: 'Standard',
  scope: 'workspace',
  projectId: null,
  isDefault: true,
  isBuiltIn: true,
  version: 0,
  stages: [
    stage('builtin:backlog', '', 'backlog', 'not_started', 0),
    stage('builtin:ready', '', 'ready', 'not_started', 1),
    stage('builtin:in_progress', '', 'in_progress', 'in_progress', 2),
    stage('builtin:internal_review', '', 'internal_review', 'in_review', 3),
    stage('builtin:done', '', 'done', 'done', 4),
  ],
  createdAt: null,
  updatedAt: null,
};

export const WORK_ITEM = {
  id: 'wi-1',
  projectId: 'proj-1',
  type: 'task',
  title: 'Design the landing page',
  description:
    'New landing page for the relaunch: hero, three feature blocks and the sign-up form. Copy comes from the approved deck.',
  state: 'in_progress',
  ownerUserId: 'u-peter',
  audience: 'client_visible',
  startAt: null,
  dueAt: '2026-12-01T12:00:00.000Z',
  completedAt: null,
  version: 7,
  createdAt: '2026-11-18T09:00:00.000Z',
  updatedAt: '2026-11-23T08:00:00.000Z',
  deletedAt: null,
  doerUserIds: ['u-peter', 'u-sara', 'u-mona'],
  stageId: 'st-prototype',
  stageName: 'Prototype',
};

const STEPS = [
  ['Collect references', true, 'u-sara', '2026-11-24'],
  ['Wireframe', true, 'u-mona', '2026-11-26'],
  ['High-fidelity design', false, 'u-peter', '2026-11-30'],
  ['Client review', false, 'u-laila', '2026-12-01'],
  ['Hand off to development', false, null, null],
] as const;

const COMMENTS = [
  ['m-sara', 'Wireframe is done. Moving to high fidelity today.', '2026-11-23T07:00:00.000Z'],
  ['m-laila', 'Looks good. Keep the sign-up form on the first screen.', '2026-11-23T08:00:00.000Z'],
] as const;

export interface WorkStoryRoutes {
  /** The item as read; defaults to {@link WORK_ITEM}. */
  readonly item?: Record<string, unknown>;
  /** No steps, files, comments or people: a work just made (Figma `WV2-09 work page new`). */
  readonly fresh?: boolean;
}

function reply(body: unknown, status = 200): Promise<Response> {
  return Promise.resolve(
    new Response(status === 204 ? null : JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    }),
  );
}

/** The work page's reads by path; anything else is an empty 404 (the page's own empty state). */
export function workClient(routes: WorkStoryRoutes = {}): ApiClient {
  const item = { ...WORK_ITEM, ...(routes.item ?? {}) };
  const fresh = routes.fresh === true;
  const fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input.toString());
    const path = url.pathname.startsWith(ORG) ? url.pathname.slice(ORG.length) : url.pathname;
    const method = init?.method ?? 'GET';
    if (method !== 'GET') return reply(item);
    switch (path) {
      case '/work-items/wi-1':
        return reply(item);
      case '/work-items/wi-1/people':
        return reply(
          fresh
            ? {
                doerUserIds: [],
                supervisorUserIds: [],
                watcherUserIds: [],
                viewerUserId: 'u-peter',
              }
            : {
                doerUserIds: ['u-peter', 'u-sara', 'u-mona'],
                supervisorUserIds: ['u-laila'],
                watcherUserIds: [],
                viewerUserId: 'u-peter',
              },
        );
      case '/work-items/wi-1/checklist':
        return reply({
          items: fresh
            ? []
            : STEPS.map(([label, done, assigneeUserId, dueOn], position) => ({
                id: `step-${position + 1}`,
                workItemId: 'wi-1',
                label,
                done,
                position,
                createdAt: '2026-11-18T09:00:00.000Z',
                assigneeUserId,
                dueOn,
              })),
        });
      case '/work-items/wi-1/comments':
        return reply({
          comments: fresh
            ? []
            : COMMENTS.map(([authorMembershipId, body, createdAt], index) => ({
                id: `c-${index + 1}`,
                workItemId: 'wi-1',
                authorMembershipId,
                body,
                createdAt,
              })),
        });
      case '/work-items/wi-1/labels':
        return reply({
          labels: fresh
            ? []
            : [
                {
                  id: 'il-1',
                  workItemId: 'wi-1',
                  labelId: 'l-1',
                  name: 'Landing',
                  color: 'lime',
                  createdAt: '',
                },
                {
                  id: 'il-2',
                  workItemId: 'wi-1',
                  labelId: 'l-2',
                  name: 'Q4',
                  color: 'blue',
                  createdAt: '',
                },
              ],
        });
      case '/work-labels':
      case '/work/labels':
        return reply({ labels: [] });
      case '/work-items/wi-1/files':
        return reply({
          files: fresh
            ? []
            : ['hero-v3.fig', 'copy-deck.pdf', 'moodboard.png'].map((fileName, index) => ({
                id: `link-${index + 1}`,
                workItemId: 'wi-1',
                fileAssetId: `asset-${index + 1}`,
                fileName,
                availability: 'ready',
                attachedByMembershipId: 'm-peter',
                createdAt: '2026-11-20T10:00:00.000Z',
              })),
        });
      case '/projects/proj-1/figma/links':
        return reply({ links: [] });
      case '/deliverables':
        return reply({ deliverables: [] });
      case '/work-items/wi-1/recurrence':
        return reply({ recurrence: null });
      case '/work-items/wi-1/estimate':
        return reply(
          fresh
            ? { estimateMinutes: null, actualMinutes: 0 }
            : { estimateMinutes: 360, actualMinutes: 200 },
        );
      case '/work-items/wi-1/links':
        return reply({ links: [] });
      case '/work-items/wi-1/activity':
        return reply({ activity: [], nextCursor: null });
      case '/projects':
        return reply({
          projects: [
            { id: 'proj-1', name: 'Website relaunch', status: 'active' },
            { id: 'proj-2', name: 'Brand refresh', status: 'active' },
          ],
        });
      case '/projects/proj-1/members':
        return reply({
          members: USERS.map((user, index) => ({
            projectMembershipId: `pm-${index}`,
            userId: user.userId,
            role: 'member',
            createdAt: '',
          })),
        });
      case '/projects/proj-1/clients':
        return reply({
          clients: [
            { id: 's-1', projectId: 'proj-1', clientOrganizationId: 'c-nile', createdAt: '' },
          ],
        });
      case '/client-organization-options':
        return reply({ clientOrganizations: [{ id: 'c-nile', name: 'Nile Foods' }] });
      case '/work-items/wi-1/client-audience':
        return reply({ clientOrganizationIds: ['c-nile'] });
      case '/projects/proj-1/stage-set':
        return reply({ source: 'workspace', stageSet: DESIGN_SET });
      case '/work/stage-sets':
        return reply({ stageSets: [BUILT_IN_SET, DESIGN_SET] });
      case '/members':
        return reply({ members: USERS, nextAfter: null });
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
