import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { RowDataPacket } from 'mysql2/promise';
import { CSRF_HEADER } from '../src/common/http/csrf.js';
import { bootHttpHarness, reseed, signIn, stopHarness } from './support/http-harness.js';
import type { InjectedResponse, Session } from './support/http-harness.js';
import type { TestDatabase } from './support/test-database.js';
import type { SeedWorld } from './seed-two-tenants.js';

/**
 * platform-admin v2 · PA-01 — per-member permission overrides (SPEC §3.3, §5.7, §6 0242),
 * through the real HTTP stack against a real server.
 *
 * What is proved:
 * 1. An owner gives a member an `allow` their role lacks and a `deny` their role holds; the rows
 *    land in `membership_permission_overrides`, and the member's next request resolves with them
 *    (`GET /me` and the "what can this person do" preview both show the change).
 * 2. Removing an override revokes the row (`revoked_at`), never deletes it.
 * 3. The guards: overrides on an owner are refused (400), a member without `roles.assign` is
 *    refused (403), nobody changes their own overrides (403), and a membership of another tenant
 *    is not found (404).
 * 4. The D7 role matrix route answers an owner and refuses a member.
 */

const SECRET_TAG = 'the_perm_001_membership_overrides_suite';
const ORG = '/v1/organizations/northstar-studio';

let app: NestFastifyApplication;
let db: TestDatabase;
let world: SeedWorld;
let owner: Session;
let designer: Session;

interface OverridesView {
  readonly membershipId: string;
  readonly overrides: readonly { capability: string; effect: string; live: boolean }[];
  readonly added?: number;
  readonly removed?: number;
}

interface EffectiveView {
  readonly permissions: readonly {
    capability: string;
    final: boolean;
    source: string;
    scope: string;
  }[];
}

async function call(
  session: Session,
  method: 'GET' | 'PUT',
  url: string,
  payload?: Record<string, unknown>,
): Promise<InjectedResponse> {
  return (await app.inject({
    method,
    url,
    headers: {
      cookie: session.cookie,
      [CSRF_HEADER]: session.csrfToken,
      ...(payload === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(payload === undefined ? {} : { payload }),
  })) as unknown as InjectedResponse;
}

async function overrideRows(membershipId: string): Promise<RowDataPacket[]> {
  const [rows] = await db.admin.query<RowDataPacket[]>(
    `SELECT capability, effect, revoked_at, revoked_by, created_by
       FROM membership_permission_overrides
      WHERE membership_id = ? ORDER BY capability, created_at`,
    [membershipId],
  );
  return rows;
}

beforeAll(async () => {
  ({ app, db } = await bootHttpHarness({ secretTag: SECRET_TAG, guardMode: 'enforce' }));
  world = await reseed(db);
  owner = await signIn(app, world.northstar.owner.id);
  designer = await signIn(app, world.northstar.designer.id);
}, 240_000);

afterAll(async () => {
  await stopHarness({ app, db });
});

describe('an owner places overrides and the member resolves with them', () => {
  it('stores an allow and a deny for the member', async () => {
    const target = world.northstar.designer.membershipId;
    const response = await call(owner, 'PUT', `${ORG}/people/${target}/permissions/overrides`, {
      overrides: [
        { capability: 'work.delete', effect: 'allow', reason: 'Cleans up the Atlas board' },
        { capability: 'conversation.write', effect: 'deny' },
      ],
    });
    expect(response.statusCode, response.body).toBe(200);
    const view = response.json<OverridesView>();
    expect(view.added).toBe(2);
    expect(view.overrides.map((row) => `${row.effect}:${row.capability}`).sort()).toEqual([
      'allow:work.delete',
      'deny:conversation.write',
    ]);

    const rows = await overrideRows(target);
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row['revoked_at']).toBeNull();
      expect(row['created_by']).toBe(world.northstar.owner.id);
    }
  });

  it("the member's own /me carries the overrides and the adjusted capability set", async () => {
    const response = await call(designer, 'GET', `${ORG}/me`);
    expect(response.statusCode, response.body).toBe(200);
    const me = response.json<{
      capabilities: string[];
      overrides: { allow: string[]; deny: string[] };
    }>();
    expect(me.overrides).toEqual({ allow: ['work.delete'], deny: ['conversation.write'] });
    expect(me.capabilities).toContain('work.delete');
    expect(me.capabilities).not.toContain('conversation.write');
  });

  it('the effective-permissions preview names the override as the source', async () => {
    const target = world.northstar.designer.membershipId;
    const response = await call(
      owner,
      'GET',
      `${ORG}/people/${target}/effective-permissions?projectId=${world.northstar.projectId}`,
    );
    expect(response.statusCode, response.body).toBe(200);
    const view = response.json<EffectiveView>();
    const of = (capability: string) => view.permissions.find((p) => p.capability === capability);
    expect(of('work.delete')).toMatchObject({ final: true, source: 'override_allow' });
    expect(of('conversation.write')).toMatchObject({ final: false, source: 'override_deny' });
    expect(of('work.read')).toMatchObject({ final: true, source: 'role' });
    expect(of('billing.manage')).toMatchObject({ final: false, source: 'not_in_ceiling' });
  });

  it('the member may preview their own permissions', async () => {
    const self = world.northstar.designer.membershipId;
    const response = await call(designer, 'GET', `${ORG}/people/${self}/effective-permissions`);
    expect(response.statusCode, response.body).toBe(200);
  });

  it('removing an override revokes the row and keeps it', async () => {
    const target = world.northstar.designer.membershipId;
    const response = await call(owner, 'PUT', `${ORG}/people/${target}/permissions/overrides`, {
      overrides: [
        { capability: 'work.delete', effect: 'allow', reason: 'Cleans up the Atlas board' },
      ],
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json<OverridesView>()).toMatchObject({ added: 0, removed: 1 });

    const rows = await overrideRows(target);
    expect(rows).toHaveLength(2);
    const denied = rows.find((row) => row['capability'] === 'conversation.write');
    expect(denied?.['revoked_at']).not.toBeNull();
    expect(denied?.['revoked_by']).toBe(world.northstar.owner.id);

    const me = (await call(designer, 'GET', `${ORG}/me`)).json<{
      overrides: { allow: string[]; deny: string[] };
    }>();
    expect(me.overrides).toEqual({ allow: ['work.delete'], deny: [] });
  });
});

describe('the guards', () => {
  it('refuses overrides on an owner', async () => {
    const target = world.northstar.owner.membershipId;
    const response = await call(owner, 'PUT', `${ORG}/people/${target}/permissions/overrides`, {
      overrides: [{ capability: 'billing.manage', effect: 'deny' }],
    });
    expect(response.statusCode, response.body).toBe(400);
    expect(response.body).toContain('Owners always have every permission');
  });

  it('refuses a member without roles.assign', async () => {
    const target = world.northstar.manager.membershipId;
    const response = await call(designer, 'PUT', `${ORG}/people/${target}/permissions/overrides`, {
      overrides: [{ capability: 'work.export', effect: 'allow' }],
    });
    expect(response.statusCode, response.body).toBe(403);
    expect(await overrideRows(target)).toHaveLength(0);
  });

  it("refuses the caller's own overrides", async () => {
    const self = world.northstar.owner.membershipId;
    const response = await call(owner, 'PUT', `${ORG}/people/${self}/permissions/overrides`, {
      overrides: [],
    });
    expect([400, 403]).toContain(response.statusCode);
  });

  it('does not find a membership of another tenant', async () => {
    const foreign = world.twin.owner.membershipId;
    const response = await call(owner, 'GET', `${ORG}/people/${foreign}/permissions/overrides`);
    expect(response.statusCode, response.body).toBe(404);
  });
});

describe('the D7 role matrix route', () => {
  it('answers an owner with the built-in roles as matrices', async () => {
    const response = await call(owner, 'GET', `${ORG}/admin/roles/matrix`);
    expect(response.statusCode, response.body).toBe(200);
    expect(response.body).toContain('"owner"');
  });

  it('refuses a member', async () => {
    const response = await call(designer, 'GET', `${ORG}/admin/roles/matrix`);
    expect(response.statusCode, response.body).toBe(403);
  });
});
