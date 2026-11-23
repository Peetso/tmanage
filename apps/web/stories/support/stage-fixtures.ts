import { ApiClient } from '../../src/lib/api/client';
import type { StageSetView, StageView } from '../../src/lib/api/work-stages';

/**
 * Work area v2 stages editor (W-WEB-5) — the stage sets Figma W7 (`937:99028`) draws: Simple (the
 * workspace default), Design thinking (Empathize · Define · Ideate · Prototype · Test · Done) and
 * Client delivery, and the project "Website relaunch" on Design thinking (W8 `937:100226`).
 *
 * The fake answers like the API's stage routes (`apps/api/src/modules/work/stages`): every write
 * changes the sets it holds and answers with the set, so a story or a test sees the result of a
 * write, and `calls` records what was sent for a test to assert on.
 */

const ORG = '/v1/organizations/northstar';

function stage(
  id: string,
  name: string,
  stateKey: string,
  group: StageView['group'],
  position: number,
): StageView {
  return { id, name, stateKey, group, colorKey: null, position };
}

const GROUP_OF: Readonly<Record<string, StageView['group']>> = {
  backlog: 'not_started',
  ready: 'not_started',
  in_progress: 'in_progress',
  internal_review: 'in_review',
  done: 'done',
};

function set(
  id: string,
  name: string,
  stages: readonly StageView[],
  extra: Partial<StageSetView> = {},
): StageSetView {
  return {
    id,
    name,
    scope: 'custom',
    projectId: null,
    isDefault: false,
    isBuiltIn: false,
    version: 1,
    stages,
    createdAt: '2026-11-01T00:00:00.000Z',
    updatedAt: '2026-11-01T00:00:00.000Z',
    ...extra,
  };
}

export function stageSetsFixture(options: { emptyReview?: boolean } = {}): StageSetView[] {
  return [
    set(
      'set-simple',
      'Simple',
      [
        stage('si-todo', 'To do', 'ready', 'not_started', 0),
        stage('si-doing', 'In progress', 'in_progress', 'in_progress', 1),
        stage('si-review', 'In review', 'internal_review', 'in_review', 2),
        stage('si-done', 'Done', 'done', 'done', 3),
      ],
      { scope: 'workspace', isDefault: true },
    ),
    set('set-design', 'Design thinking', [
      stage('st-empathize', 'Empathize', 'ready', 'not_started', 0),
      stage('st-define', 'Define', 'in_progress', 'in_progress', 1),
      stage('st-ideate', 'Ideate', 'in_progress', 'in_progress', 2),
      stage('st-prototype', 'Prototype', 'in_progress', 'in_progress', 3),
      ...(options.emptyReview ? [] : [stage('st-test', 'Test', 'internal_review', 'in_review', 4)]),
      stage('st-done', 'Done', 'done', 'done', 5),
    ]),
    set('set-client', 'Client delivery', [
      stage('cd-brief', 'Brief', 'ready', 'not_started', 0),
      stage('cd-make', 'Make', 'in_progress', 'in_progress', 1),
      stage('cd-client', 'Client review', 'internal_review', 'in_review', 2),
      stage('cd-done', 'Delivered', 'done', 'done', 3),
    ]),
  ];
}

export interface StageCall {
  readonly method: string;
  readonly path: string;
  readonly search: string;
  readonly body: unknown;
}

export interface StagesWorld {
  readonly client: ApiClient;
  readonly calls: StageCall[];
  sets(): readonly StageSetView[];
}

function reply(body: unknown, status = 200): Promise<Response> {
  return Promise.resolve(
    new Response(status === 204 ? null : JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    }),
  );
}

function ordered(stages: readonly StageView[]): StageView[] {
  return [...stages]
    .sort((a, b) => a.position - b.position)
    .map((s, position) => ({ ...s, position }));
}

/** A stateful fake of the stage routes; `projectSetId` is what "Website relaunch" (proj-1) uses. */
export function stagesWorld(
  options: { emptyReview?: boolean; projectSetId?: string | null; failWrites?: number } = {},
): StagesWorld {
  let sets = stageSetsFixture(options);
  let projectSetId = options.projectSetId === undefined ? 'set-design' : options.projectSetId;
  let next = 1;
  const calls: StageCall[] = [];
  const effective = () => {
    const own = sets.find((entry) => entry.id === projectSetId);
    return own
      ? { source: 'project', stageSet: own }
      : { source: 'workspace', stageSet: sets.find((entry) => entry.isDefault) };
  };
  const change = (id: string, edit: (entry: StageSetView) => StageSetView) => {
    sets = sets.map((entry) =>
      entry.id === id ? { ...edit(entry), version: entry.version + 1 } : entry,
    );
    return sets.find((entry) => entry.id === id);
  };
  const fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input.toString());
    const path = url.pathname.startsWith(ORG) ? url.pathname.slice(ORG.length) : url.pathname;
    const method = (init?.method ?? 'GET').toUpperCase();
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined;
    calls.push({ method, path, search: url.search, body });
    if (method !== 'GET' && options.failWrites !== undefined) {
      return reply(
        { error: { code: 'conflict', message: 'Somebody changed this first.' } },
        options.failWrites,
      );
    }
    const input_ = (body ?? {}) as Record<string, unknown>;
    let m: RegExpExecArray | null;
    // The shell's own read: an owner, so the Control Center menu shows Stages.
    if (path === '/v1/organizations' && method === 'GET') {
      return reply({
        organizations: [
          {
            id: 'org-1',
            slug: 'northstar',
            name: 'Northstar Studio',
            audience: 'internal',
            role: 'owner',
            clientOrganizationName: null,
          },
        ],
      });
    }
    if (path === '/work/stage-sets' && method === 'GET') return reply({ stageSets: sets });
    if (path === '/work/stage-sets' && method === 'POST') {
      const id = `set-new-${next++}`;
      const stages = (input_['stages'] as { name: string; stateKey: string }[]).map((s, i) =>
        stage(`${id}-s${i}`, s.name, s.stateKey, GROUP_OF[s.stateKey] ?? 'in_progress', i),
      );
      const projectId = (input_['projectId'] as string | undefined) ?? null;
      const created = set(id, input_['name'] as string, stages, {
        projectId,
        scope: projectId ? 'project' : 'custom',
      });
      sets = [...sets, created];
      if (projectId) projectSetId = id;
      return reply(created, 201);
    }
    if ((m = /^\/work\/stage-sets\/([^/]+)$/.exec(path))) {
      const id = decodeURIComponent(m[1] ?? '');
      if (method === 'PATCH') {
        if (input_['isDefault'] === true) {
          sets = sets.map((entry) => ({ ...entry, isDefault: entry.id === id }));
        }
        return reply(
          change(id, (entry) => ({
            ...entry,
            ...(typeof input_['name'] === 'string' ? { name: input_['name'] } : {}),
          })),
        );
      }
      if (method === 'DELETE') {
        sets = sets.filter((entry) => entry.id !== id);
        return reply(null, 204);
      }
    }
    if ((m = /^\/work\/stage-sets\/([^/]+)\/stages\/order$/.exec(path)) && method === 'PUT') {
      const ids = input_['stageIds'] as string[];
      return reply(
        change(decodeURIComponent(m[1] ?? ''), (entry) => ({
          ...entry,
          stages: entry.stages.map((s) => ({ ...s, position: ids.indexOf(s.id) })),
        })),
      );
    }
    if ((m = /^\/work\/stage-sets\/([^/]+)\/stages$/.exec(path)) && method === 'POST') {
      const id = decodeURIComponent(m[1] ?? '');
      const at = input_['position'] as number;
      const added = stage(
        `stage-new-${next++}`,
        input_['name'] as string,
        input_['stateKey'] as string,
        GROUP_OF[input_['stateKey'] as string] ?? 'in_progress',
        at - 0.5,
      );
      return reply(
        change(id, (entry) => ({ ...entry, stages: ordered([...entry.stages, added]) })),
      );
    }
    if ((m = /^\/work\/stage-sets\/([^/]+)\/stages\/([^/]+)$/.exec(path))) {
      const id = decodeURIComponent(m[1] ?? '');
      const stageId = decodeURIComponent(m[2] ?? '');
      if (method === 'PATCH') {
        return reply(
          change(id, (entry) => ({
            ...entry,
            stages: entry.stages.map((s) =>
              s.id === stageId ? { ...s, name: input_['name'] as string } : s,
            ),
          })),
        );
      }
      if (method === 'DELETE') {
        return reply(
          change(id, (entry) => ({
            ...entry,
            stages: ordered(entry.stages.filter((s) => s.id !== stageId)),
          })),
        );
      }
    }
    if (path === '/projects/proj-1/stage-set') {
      if (method === 'PUT') projectSetId = (input_['stageSetId'] as string | null) ?? null;
      return reply(effective());
    }
    if (path === '/projects/proj-1' && method === 'GET') {
      return reply({ id: 'proj-1', name: 'Website relaunch', status: 'active' });
    }
    if ((m = /^\/work-items\/([^/]+)\/stage-set$/.exec(path)) && method === 'PUT') {
      return reply({ id: decodeURIComponent(m[1] ?? ''), version: 2 });
    }
    return reply({ error: { code: 'not_found', message: 'Not found' } }, 404);
  }) as typeof globalThis.fetch;
  return {
    client: new ApiClient({
      baseUrl: 'https://app.example.test',
      csrfCookieName: 'tm_session_csrf',
      readCsrfToken: () => undefined,
      newCorrelationId: () => 'correlation-stages',
      fetch,
    }),
    calls,
    sets: () => sets,
  };
}
