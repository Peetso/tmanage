import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { Capability } from '@tmanage/domain';
import { CSRF_HEADER } from '../src/common/http/csrf.js';
import { bootHttpHarness, reseed, signIn, stopHarness } from './support/http-harness.js';
import type { InjectedResponse, Session } from './support/http-harness.js';
import type { TestDatabase } from './support/test-database.js';
import type { SeedWorld } from './seed-two-tenants.js';

/**
 * AUTH-53-50 (53 §53-20 audit debt, release gate line 1) — a custom role's ceiling holds over the
 * real API against a real MariaDB.
 *
 * The Northstar owner creates three custom roles with reduced ceilings in Control > Roles
 * (`POST admin/roles`) and gives one each to three Atlas project members
 * (`PATCH members/:userId/role` with `customRoleId`) — the same calls `admin-001` and `h1` make.
 * Then a 12-capability × 3-role matrix, one assertion per cell (36): every read, write and
 * transition outside the role's ceiling is refused by the route guard with the oracle's 403 (the
 * caller is a member, so the refusal may name the capability; a hidden object would be a 404), and
 * every one inside it succeeds on the member's own project.
 *
 * BrightOps (the second tenant of the two-org fixture) is untouched: the roles are Northstar's.
 */

const SECRET_TAG = 'the_auth_053_custom_roles_ceiling_suite';
const ORG = '/v1/organizations/northstar-studio';

type Kind = 'read' | 'write' | 'transition';

/** The three ceilings — the same sets UNIT-53-51 simulates. */
const ROLES = {
  reviewer: {
    name: 'Read-only reviewer',
    capabilities: ['work.read', 'conversation.read', 'meeting.read', 'people.view'],
  },
  contributor: {
    name: 'Work contributor',
    capabilities: ['work.read', 'work.create', 'work.update', 'conversation.read'],
  },
  operator: {
    name: 'Flow operator',
    capabilities: ['work.read', 'work.transition', 'audit.read', 'decision.read'],
  },
} as const satisfies Record<string, { name: string; capabilities: readonly Capability[] }>;

type RoleKey = keyof typeof ROLES;

let app: NestFastifyApplication;
let db: TestDatabase;
let world: SeedWorld;
let owner: Session;
const sessions = new Map<RoleKey, Session>();

/** The Atlas project members who take the roles: Omar, Lina and Rania. */
const holders = (): Record<RoleKey, string> => ({
  reviewer: world.northstar.manager.id,
  contributor: world.northstar.designer.id,
  operator: world.northstar.offboardee.id,
});
const project = () => world.northstar.projectId;

async function call(
  session: Session,
  method: 'GET' | 'POST' | 'PATCH',
  url: string,
  payload?: Record<string, unknown>,
): Promise<InjectedResponse> {
  return (await app.inject({
    method,
    url: `${ORG}${url}`,
    headers: {
      cookie: session.cookie,
      ...(method === 'GET' ? {} : { [CSRF_HEADER]: session.csrfToken }),
      ...(payload === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(payload === undefined ? {} : { payload }),
  })) as unknown as InjectedResponse;
}

/** A fresh Atlas work item, made by the owner, for a write or transition probe to act on. */
async function freshItem(): Promise<{ id: string; version: number }> {
  const response = await call(owner, 'POST', '/work-items', {
    projectId: project(),
    title: 'Ceiling probe',
  });
  expect(response.statusCode, response.body).toBe(201);
  return response.json<{ id: string; version: number }>();
}

interface Probe {
  readonly capability: Capability;
  readonly kind: Kind;
  /** The status the route answers when the capability is held. */
  readonly allowed: number;
  readonly send: (session: Session) => Promise<InjectedResponse>;
}

/** Twelve capabilities, each probed through one real route that requires exactly it. */
const PROBES: readonly Probe[] = [
  {
    capability: 'work.read',
    kind: 'read',
    allowed: 200,
    send: (s) => call(s, 'GET', `/work-items?projectId=${project()}`),
  },
  {
    capability: 'work.create',
    kind: 'write',
    allowed: 201,
    send: (s) => call(s, 'POST', '/work-items', { projectId: project(), title: 'Made in role' }),
  },
  {
    capability: 'work.update',
    kind: 'write',
    allowed: 200,
    send: async (s) => {
      const item = await freshItem();
      return call(s, 'PATCH', `/work-items/${item.id}`, {
        version: item.version,
        title: 'Renamed in role',
      });
    },
  },
  {
    capability: 'work.transition',
    kind: 'transition',
    allowed: 200,
    send: async (s) => {
      const item = await freshItem();
      return call(s, 'POST', `/work-items/${item.id}/transitions`, {
        version: item.version,
        to: 'ready',
      });
    },
  },
  {
    capability: 'conversation.read',
    kind: 'read',
    allowed: 200,
    send: (s) => call(s, 'GET', '/conversations'),
  },
  {
    capability: 'conversation.write',
    kind: 'write',
    allowed: 201,
    send: (s) => call(s, 'POST', '/conversations', { projectId: project(), name: 'role-room' }),
  },
  {
    capability: 'meeting.read',
    kind: 'read',
    allowed: 200,
    send: (s) => call(s, 'GET', `/meetings?projectId=${project()}`),
  },
  {
    capability: 'meeting.write',
    kind: 'write',
    allowed: 201,
    send: (s) =>
      call(s, 'POST', '/meetings', {
        projectId: project(),
        title: 'Role sync',
        startsAt: '2026-11-02T09:00:00.000Z',
        endsAt: '2026-11-02T09:30:00.000Z',
      }),
  },
  {
    capability: 'decision.read',
    kind: 'read',
    allowed: 200,
    send: (s) => call(s, 'GET', `/decisions?projectId=${project()}`),
  },
  {
    capability: 'decision.write',
    kind: 'write',
    allowed: 201,
    send: (s) => call(s, 'POST', '/decisions', { projectId: project(), title: 'Role decision' }),
  },
  { capability: 'people.view', kind: 'read', allowed: 200, send: (s) => call(s, 'GET', '/people') },
  {
    capability: 'audit.read',
    kind: 'read',
    allowed: 200,
    send: (s) => call(s, 'GET', '/audit/events'),
  },
];

const CELLS = (Object.keys(ROLES) as RoleKey[]).flatMap((role) =>
  PROBES.map((probe) => {
    const held = (ROLES[role].capabilities as readonly Capability[]).includes(probe.capability);
    return [
      `${ROLES[role].name} · ${probe.kind} ${probe.capability} → ${held ? 'allowed' : 'refused'}`,
      role,
      probe,
      held,
    ] as const;
  }),
);

beforeAll(async () => {
  ({ app, db } = await bootHttpHarness({ secretTag: SECRET_TAG, guardMode: 'enforce' }));
  world = await reseed(db);
  owner = await signIn(app, world.northstar.owner.id);

  for (const role of Object.keys(ROLES) as RoleKey[]) {
    const created = await call(owner, 'POST', '/admin/roles', {
      name: ROLES[role].name,
      capabilities: [...ROLES[role].capabilities],
    });
    expect(created.statusCode, created.body).toBe(201);
    const roleId = created
      .json<{ roles: { id: string; name: string }[] }>()
      .roles.find((row) => row.name === ROLES[role].name)?.id;
    if (roleId === undefined) throw new Error(`no role named ${ROLES[role].name}`);

    const assigned = await call(owner, 'PATCH', `/members/${holders()[role]}/role`, {
      customRoleId: roleId,
    });
    expect(assigned.statusCode, assigned.body).toBe(200);
    // Signed in after the change, so the session resolves under the custom role.
    sessions.set(role, await signIn(app, holders()[role]));
  }
}, 300_000);

afterAll(async () => {
  await stopHarness({ app, db });
});

describe('AUTH-53-50 — a custom role is held to its ceiling (12 capabilities × 3 roles)', () => {
  it('the matrix is 36 cells, and every role is both allowed and refused somewhere', () => {
    expect(CELLS).toHaveLength(36);
    for (const role of Object.keys(ROLES)) {
      const mine = CELLS.filter(([, cellRole]) => cellRole === role).map(([, , , held]) => held);
      expect(new Set(mine)).toEqual(new Set([true, false]));
    }
  });

  it.each(CELLS)('%s', async (_label, role, probe, held) => {
    const session = sessions.get(role);
    if (!session) throw new Error(`no session for ${role}`);
    const response = await probe.send(session);
    expect(response.statusCode, response.body).toBe(held ? probe.allowed : 403);
  });
});
