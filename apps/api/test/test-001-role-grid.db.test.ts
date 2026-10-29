import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { RowDataPacket } from 'mysql2/promise';
import { CLIENT_ROLES, ASSIGNABLE_INTERNAL_ROLES, uuidv7 } from '@tmanage/domain';
import type { Role } from '@tmanage/domain';
import {
  buildRoleOperationGrid,
  expectedGuardDenialCount,
  GUARDED_OPERATIONS,
  GRID_ROLES,
} from '@tmanage/test-kit';
import type { GuardedOperation } from '@tmanage/test-kit';
import { CSRF_HEADER } from '../src/common/http/csrf.js';
import { bootHttpHarness, signIn, stopHarness } from './support/http-harness.js';
import type { InjectedResponse, Session } from './support/http-harness.js';
import type { TestDatabase } from './support/test-database.js';
import { truncateAll } from './support/test-database.js';
import { seedTwoTenants } from './seed-two-tenants.js';
import type { SeedWorld } from './seed-two-tenants.js';

/**
 * TEST-001 §11, the whole role × operation grid — generated, and driven cell by cell over HTTP.
 *
 * The grid, its coverage guarantee (a newly declared capability fails loudly), and why each
 * verdict comes from the transcription rather than `hasCapability` all live in the generator,
 * `packages/test-kit/src/role-operation-grid.ts`; the mutation check §Item-3 AC3 asks for is
 * proved there without a database in `role-operation-grid.test.ts`. This suite is the driver.
 *
 * Each cell is judged by the guard's audit row, not the status code. `CapabilityGuard` is the
 * only writer of `security.capability_denied` (§12, AUD-001), so an allowed cell produces **no
 * new** row (whatever the handler then returns) and a denied cell produces **exactly one** new
 * row and a 403. Reading the row rather than the status is what lets one sweep cover both the
 * internal and portal surfaces without special cases — the owner/org_admin blanket-grant seam on
 * portal routes (`ACCEPTED_CEILING_DIVERGENCES`) is an allowed-by-guard cell whose status this
 * suite leaves unasserted, flagged by the generator as `crossSurface`.
 */

let db: TestDatabase;
let app: NestFastifyApplication;
let world: SeedWorld;

/** One seeded user per role — the grid needs every row, and the seed world has only some. */
const roleUsers = new Map<Role, string>();

const ORG_PATH = '/v1/organizations/northstar-studio';

async function observeDenialCount(organizationId: string): Promise<number> {
  const [rows] = await db.admin.query<RowDataPacket[]>(
    `select count(*) as n from audit_events
      where organization_id = ? and action = 'security.capability_denied'`,
    [organizationId],
  );
  return Number(rows[0]?.['n'] ?? 0);
}

async function drive(op: GuardedOperation, session: Session): Promise<InjectedResponse> {
  const isMutation = op.method !== 'GET';
  return (await app.inject({
    method: op.method,
    url: `${ORG_PATH}${op.path}`,
    headers: {
      cookie: session.cookie,
      // Guard order is CSRF (2) → TenantContext (3) → Capability (4): an unsafe method without
      // the session-bound token 403s at CsrfGuard before the capability guard can run, so send
      // it, and a JSON body the guard never inspects but the parser expects.
      ...(isMutation
        ? { [CSRF_HEADER]: session.csrfToken, 'content-type': 'application/json' }
        : {}),
    },
    ...(isMutation ? { payload: {} } : {}),
  })) as unknown as InjectedResponse;
}

beforeAll(async () => {
  const harness = await bootHttpHarness({ secretTag: 'the_role_grid_suite' });
  app = harness.app;
  db = harness.db;

  await truncateAll(db.admin);
  world = await seedTwoTenants(db.admin);

  // One person per role, all inside Northstar so every denial files under the one organization
  // this suite counts. Internal roles get a membership (org-wide scope only where the ceiling is
  // org-wide, per x59); client roles get a client membership in Atlas, which is already shared to
  // the Atlas project, so their allowed portal reads resolve to a real projection.
  for (const role of ASSIGNABLE_INTERNAL_ROLES) {
    const userId = uuidv7();
    await db.admin.execute(
      `insert into users (id, email, display_name, email_verified_at)
       values (?, ?, ?, utc_timestamp(3))`,
      [userId, `${role.replace(/_/g, '-')}@grid.northstar.example`, `Grid ${role}`],
    );
    await db.admin.execute(
      `insert into memberships (id, organization_id, user_id, role, has_org_wide_scope)
       values (?, ?, ?, ?, ?)`,
      [
        uuidv7(),
        world.northstar.organizationId,
        userId,
        role,
        role === 'owner' || role === 'org_admin',
      ],
    );
    roleUsers.set(role, userId);
  }

  for (const role of CLIENT_ROLES) {
    const userId = uuidv7();
    await db.admin.execute(
      `insert into users (id, email, display_name, email_verified_at)
       values (?, ?, ?, utc_timestamp(3))`,
      [userId, `${role.replace(/_/g, '-')}@grid.atlas.example`, `Grid ${role}`],
    );
    await db.admin.execute(
      `insert into client_memberships
         (id, organization_id, client_organization_id, user_id, role)
       values (?, ?, ?, ?, ?)`,
      [uuidv7(), world.northstar.organizationId, world.atlas.clientOrganizationId, userId, role],
    );
    roleUsers.set(role, userId);
  }
}, 300_000);

afterAll(async () => {
  await stopHarness({ app, db });
});

describe('§11 role × operation grid, generated from the capability ceiling', () => {
  it('covers every role and every operation the generator emits', () => {
    // A guard against silent shrinkage: the seeded rows and the grid must line up before a
    // single request is made.
    expect(GRID_ROLES).toEqual([...ASSIGNABLE_INTERNAL_ROLES, ...CLIENT_ROLES]);
    for (const role of GRID_ROLES) expect(roleUsers.has(role)).toBe(true);
    expect(GUARDED_OPERATIONS.length).toBeGreaterThan(0);
  });

  it('drives every cell and the guard allows and refuses exactly where the matrix says', async () => {
    const grid = buildRoleOperationGrid();
    const sessions = new Map<Role, Session>();
    for (const role of GRID_ROLES) {
      // The client dev-session sign-in path is the same one; a client cookie resolves to its
      // client membership at TenantContextGuard, exactly as the existing suite relies on.
      const login = await signInFor(roleUsers.get(role) as string);
      sessions.set(role, login);
    }

    let seenDenials = await observeDenialCount(world.northstar.organizationId);

    for (const cell of grid) {
      const session = sessions.get(cell.role) as Session;
      const response = await drive(cell.operation, session);
      const after = await observeDenialCount(world.northstar.organizationId);
      const delta = after - seenDenials;
      seenDenials = after;

      const where = `${cell.role} × ${cell.operation.capability} (${cell.operation.method} ${cell.operation.path})`;
      if (cell.expectedAllowed) {
        // Allowed = the guard did not refuse. No new security event, whatever the handler then does.
        expect(delta, `${where}: allowed cell must not produce a guard denial`).toBe(0);
        // A same-surface collection route that has vanished would 404; an id-bearing or
        // cross-surface route can 404 legitimately from the handler, so only the first is checked.
        if (cell.operation.collection && !cell.crossSurface) {
          expect(
            response.statusCode,
            `${where}: allowed collection route must still exist`,
          ).not.toBe(404);
        }
      } else {
        // Denied = the guard refused: a 403 and exactly one security event, no more, no fewer.
        expect(response.statusCode, `${where}: denied cell must be a 403`).toBe(403);
        expect(delta, `${where}: denied cell must write exactly one security event`).toBe(1);
      }
    }
  });

  it('wrote one security event per denied cell across the whole sweep, and only those', async () => {
    // The aggregate cross-check: the per-cell deltas above must sum to the transcription's
    // denial count. A missing row is a silent refusal; a surplus row is a phantom attempt.
    const expected = expectedGuardDenialCount();
    expect(expected).toBeGreaterThan(0);
    const total = await observeDenialCount(world.northstar.organizationId);
    expect(total).toBe(expected);
  });
});

/**
 * Sign in through the shared harness. Split out only so the client and internal paths read the
 * same at the call site; both resolve their membership at `TenantContextGuard`.
 */
async function signInFor(userId: string): Promise<Session> {
  return signIn(app, userId, { csrf: true });
}
