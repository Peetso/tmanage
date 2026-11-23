import { ApiClient } from '../../src/lib/api/client';

/**
 * Teams page story data (W-WEB-4), the people and teams of Figma `WV2-05`: Design (5),
 * Development (4), Client success (3), Marketing (2); 14 people. Arabic names follow the AR frame.
 */
const ORG = '/v1/organizations/northstar';

const EN = {
  peter: 'Peter Kamal',
  sara: 'Sara Adel',
  mona: 'Mona Rashad',
  youssef: 'Youssef Tarek',
  laila: 'Laila Hassan',
  teams: ['Design', 'Development', 'Client success', 'Marketing'],
};
const AR = {
  peter: 'بيتر كمال',
  sara: 'سارة عادل',
  mona: 'منى رشاد',
  youssef: 'يوسف طارق',
  laila: 'ليلى حسن',
  teams: ['التصميم', 'البرمجة', 'نجاح العملاء', 'التسويق'],
};

export interface TeamsStoryOptions {
  readonly arabic?: boolean;
  /** No team yet (Figma `WV2-09` "no teams yet"). */
  readonly empty?: boolean;
  /** Design has nobody in it (Figma `WV2-09` "team with no members"). */
  readonly designEmpty?: boolean;
}

function reply(body: unknown, status = 200): Promise<Response> {
  return Promise.resolve(
    new Response(status === 204 ? null : JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    }),
  );
}

export function teamsClient(options: TeamsStoryOptions = {}): ApiClient {
  const words = options.arabic ? AR : EN;
  const person = (key: 'peter' | 'sara' | 'mona' | 'youssef' | 'laila', open: number) => ({
    membershipId: `m-${key}`,
    userId: `u-${key}`,
    displayName: words[key],
    role: 'member',
    status: 'active',
    openWorkCount: open,
  });
  const design = options.designEmpty
    ? []
    : [
        person('peter', 4),
        person('sara', 3),
        person('mona', 5),
        person('youssef', 2),
        person('laila', 1),
      ];
  const counts = [design.length, 4, 3, 2];
  const three = [person('peter', 0), person('sara', 0), person('mona', 0)];
  const teams = words.teams.map((name, index) => ({
    id: `team-${index + 1}`,
    name,
    memberCount: counts[index] ?? 0,
    faces: (index === 0 ? design : three)
      .slice(0, Math.min(3, counts[index] ?? 0))
      .map(({ userId, displayName }) => ({ userId, displayName })),
    createdAt: '2026-11-01T09:00:00.000Z',
  }));

  const fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input.toString());
    const method = init?.method ?? 'GET';
    if (method !== 'GET') return reply(null, 204);
    const path = url.pathname.startsWith(ORG) ? url.pathname.slice(ORG.length) : url.pathname;
    if (path === '/people/teams') {
      return reply(options.empty ? { teams: [], peopleCount: 0 } : { teams, peopleCount: 14 });
    }
    const team = /^\/people\/teams\/(team-\d)$/u.exec(path)?.[1];
    if (team) {
      const row = teams.find((candidate) => candidate.id === team);
      return reply({
        id: team,
        name: row?.name ?? '',
        createdAt: '2026-11-01T09:00:00.000Z',
        members: team === 'team-1' ? design : [],
      });
    }
    if (path === '/people') {
      return reply({
        people: (['peter', 'sara', 'mona', 'youssef', 'laila'] as const).map((key) => ({
          ...person(key, 0),
          email: null,
          roleName: null,
          projectCount: 0,
          version: 1,
          lastActiveAt: null,
          teams: [],
          openCommitments: 0,
          overdueCommitments: 0,
          declared: null,
        })),
        nextAfter: null,
      });
    }
    return reply({ error: { code: 'not_found', message: 'Not found' } }, 404);
  }) as typeof globalThis.fetch;

  return new ApiClient({
    baseUrl: 'https://api.example.test',
    csrfCookieName: 'tm_session_csrf',
    readCsrfToken: () => undefined,
    newCorrelationId: () => 'correlation-story',
    fetch,
  });
}
