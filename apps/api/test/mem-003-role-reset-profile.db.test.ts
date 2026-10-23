import 'reflect-metadata';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { RowDataPacket } from 'mysql2/promise';
import { uuidv7 } from '@tmanage/domain';
import type { MailDelivery, Mailer, MailMessage } from '@tmanage/mail';
import { AppModule } from '../src/app.module.js';
import { DatabaseModule } from '../src/common/database/database.module.js';
import { MailerModule } from '../src/common/email/mailer.module.js';
import { CSRF_HEADER } from '../src/common/http/csrf.js';
import { startTestDatabase } from './support/test-database.js';
import type { TestDatabase } from './support/test-database.js';
import type { SeedWorld } from './seed-two-tenants.js';
import {
  reseed,
  signIn as harnessSignIn,
  stopHarness,
  testApiConfig,
} from './support/http-harness.js';
import type { InjectedResponse, Session } from './support/http-harness.js';

/**
 * MEM-003 over real HTTP — three member-administration routes that had unit proof only:
 *
 * 1. **BK2** `PATCH …/members/:userId/role` — a member's built-in role. Who may (owner, org admin),
 *    the owner seat kept owner-only, the last owner kept, the `membership.role_changed` row, the
 *    `policy_version` bump that makes an already-issued session act on the new role, and the
 *    tenant boundary. Beside it, SEC-011 (7ab342c2): the owner's exemption from the escalation
 *    guard is gone, so a **custom** role carrying the reviewer-gated `approval.decide` is refused
 *    to the owner on the bulk route — while the built-in route, which is not a grant of a custom
 *    capability subset, still moves a person onto a built-in role.
 * 2. **Q4** `POST …/members/:membershipId/password-reset` — an org admin sends the ordinary reset
 *    link: audited before delivery, identifiers only in the audit row, never yourself, never an
 *    inactive or foreign membership.
 * 3. **me/profile** `GET/PUT …/me/profile` — the caller's own name (global) and job title
 *    (tenant-local), audited by which fields changed and never their values.
 */

let db: TestDatabase;
let world: SeedWorld;
let app: NestFastifyApplication;

const NORTHSTAR = 'northstar-studio';
const WEB_URL = 'https://app.tmanage.example';

class RecordingMailer implements Mailer {
  readonly messages: MailMessage[] = [];
  send(message: MailMessage): Promise<MailDelivery> {
    this.messages.push(message);
    return Promise.resolve('sent');
  }
}
const transport = new RecordingMailer();

async function observe(sql: string, params: readonly unknown[] = []): Promise<RowDataPacket[]> {
  const [rows] = await db.admin.query<RowDataPacket[]>(sql, params as unknown[]);
  return rows;
}

function metadataOf(raw: unknown): Record<string, unknown> {
  return (typeof raw === 'string' ? JSON.parse(raw) : raw) as Record<string, unknown>;
}

function signIn(userId: string): Promise<Session> {
  return harnessSignIn(app, userId);
}

async function send(
  method: 'GET' | 'POST' | 'PATCH' | 'PUT',
  path: string,
  session: Session,
  payload?: unknown,
  slug = NORTHSTAR,
): Promise<InjectedResponse> {
  return (await app.inject({
    method,
    url: `/v1/organizations/${slug}${path}`,
    headers: {
      ...(payload === undefined ? {} : { 'content-type': 'application/json' }),
      cookie: session.cookie,
      ...(method === 'GET' ? {} : { [CSRF_HEADER]: session.csrfToken }),
    },
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
  })) as unknown as InjectedResponse;
}

async function membershipRow(id: string): Promise<RowDataPacket | undefined> {
  const rows = await observe(
    'select role, status, version, policy_version from memberships where id = ?',
    [id],
  );
  return rows[0];
}

async function auditRows(action: string): Promise<RowDataPacket[]> {
  return observe(
    `select organization_id, actor_user_id, object_id, metadata_json from audit_events
      where action = ? order by created_at, id`,
    [action],
  );
}

async function resetTokensFor(userId: string): Promise<RowDataPacket[]> {
  return observe('select id from password_reset_tokens where user_id = ?', [userId]);
}

/** Wait briefly for the fire-and-forget reset delivery to reach the recording transport. */
async function settledMail(): Promise<void> {
  for (let attempt = 0; attempt < 50 && transport.messages.length === 0; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

beforeAll(async () => {
  db = await startTestDatabase();
  app = await NestFactory.create<NestFastifyApplication>(
    AppModule.register({
      config: testApiConfig('the_member_role_reset_profile_suite'),
      database: DatabaseModule.forPool({ pool: db.runtime, guardMode: 'enforce' }),
      mailer: MailerModule.forMailer(transport, WEB_URL),
    }),
    new FastifyAdapter(),
    { logger: false, abortOnError: false },
  );
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
}, 300_000);

beforeEach(async () => {
  transport.messages.length = 0;
  world = await reseed(db);
});

afterAll(async () => {
  await stopHarness({ app, db });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('BK2: changing a member’s built-in role', () => {
  it('an owner promotes a member: the row, both version tokens and one audit row move', async () => {
    const designer = world.northstar.designer;
    const before = await membershipRow(designer.membershipId);
    const session = await signIn(world.northstar.owner.id);

    const response = await send('PATCH', `/members/${designer.id}/role`, session, {
      role: 'manager',
      version: before?.['version'],
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      userId: designer.id,
      membershipId: designer.membershipId,
      previousRole: 'member',
      role: 'manager',
      changed: true,
    });

    const after = await membershipRow(designer.membershipId);
    expect(after?.['role']).toBe('manager');
    expect(Number(after?.['version'])).toBe(Number(before?.['version']) + 1);
    expect(Number(after?.['policy_version'])).toBe(Number(before?.['policy_version']) + 1);

    const events = await auditRows('membership.role_changed');
    expect(events).toHaveLength(1);
    expect(events[0]?.['organization_id']).toBe(world.northstar.organizationId);
    expect(events[0]?.['actor_user_id']).toBe(world.northstar.owner.id);
    expect(events[0]?.['object_id']).toBe(designer.membershipId);
    expect(metadataOf(events[0]?.['metadata_json'])).toEqual({
      target_user_id: designer.id,
      previous_role: 'member',
      new_role: 'manager',
    });
  });

  it('a session issued before the change acts on the new role at once', async () => {
    const designer = world.northstar.designer;
    const designerSession = await signIn(designer.id);
    // A member holds no org.manage: the built-in role catalogue is an admin surface.
    expect((await send('GET', '/admin/roles/built-in', designerSession)).statusCode).toBe(403);

    const owner = await signIn(world.northstar.owner.id);
    const promoted = await send('PATCH', `/members/${designer.id}/role`, owner, {
      role: 'org_admin',
    });
    expect(promoted.statusCode).toBe(200);

    // Same cookie, no re-sign-in: the policy_version bump rotates the stale context.
    expect((await send('GET', '/admin/roles/built-in', designerSession)).statusCode).toBe(200);
  });

  it('a no-op change writes nothing and records nothing', async () => {
    const before = await membershipRow(world.northstar.designer.membershipId);
    const session = await signIn(world.northstar.owner.id);
    const response = await send('PATCH', `/members/${world.northstar.designer.id}/role`, session, {
      role: 'member',
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ changed: false });
    expect(await membershipRow(world.northstar.designer.membershipId)).toEqual(before);
    expect(await auditRows('membership.role_changed')).toHaveLength(0);
  });

  it('a manager (no org.manage) is refused, with no write and no audit row', async () => {
    const before = await membershipRow(world.northstar.designer.membershipId);
    const session = await signIn(world.northstar.manager.id);
    const response = await send('PATCH', `/members/${world.northstar.designer.id}/role`, session, {
      role: 'manager',
    });
    expect(response.statusCode).toBe(403);
    expect(await membershipRow(world.northstar.designer.membershipId)).toEqual(before);
    expect(await auditRows('membership.role_changed')).toHaveLength(0);
  });

  it('an org admin may re-role a member but may not grant owner or touch the owner’s seat', async () => {
    const owner = await signIn(world.northstar.owner.id);
    expect(
      (
        await send('PATCH', `/members/${world.northstar.manager.id}/role`, owner, {
          role: 'org_admin',
        })
      ).statusCode,
    ).toBe(200);
    const admin = await signIn(world.northstar.manager.id);

    const grantOwner = await send('PATCH', `/members/${world.northstar.designer.id}/role`, admin, {
      role: 'owner',
    });
    expect(grantOwner.statusCode).toBe(403);
    expect((await membershipRow(world.northstar.designer.membershipId))?.['role']).toBe('member');

    const demoteOwner = await send('PATCH', `/members/${world.northstar.owner.id}/role`, admin, {
      role: 'member',
    });
    expect(demoteOwner.statusCode).toBe(403);
    expect((await membershipRow(world.northstar.owner.membershipId))?.['role']).toBe('owner');

    const ordinary = await send('PATCH', `/members/${world.northstar.designer.id}/role`, admin, {
      role: 'moderator',
    });
    expect(ordinary.statusCode).toBe(200);
    expect((await membershipRow(world.northstar.designer.membershipId))?.['role']).toBe(
      'moderator',
    );
    // The owner's promotion of the admin and the admin's one landed change; the refusals none.
    expect(await auditRows('membership.role_changed')).toHaveLength(2);
  });

  it('the last active owner cannot be demoted, even by themselves', async () => {
    const session = await signIn(world.northstar.owner.id);
    const response = await send('PATCH', `/members/${world.northstar.owner.id}/role`, session, {
      role: 'org_admin',
    });
    expect(response.statusCode).toBe(409);
    expect((await membershipRow(world.northstar.owner.membershipId))?.['role']).toBe('owner');
    expect(await auditRows('membership.role_changed')).toHaveLength(0);
  });

  it('a stale version is a conflict, not an overwrite', async () => {
    const session = await signIn(world.northstar.owner.id);
    const before = await membershipRow(world.northstar.designer.membershipId);
    const response = await send('PATCH', `/members/${world.northstar.designer.id}/role`, session, {
      role: 'manager',
      version: Number(before?.['version']) + 5,
    });
    expect(response.statusCode).toBe(409);
    expect(await membershipRow(world.northstar.designer.membershipId)).toEqual(before);
  });

  it('a user id from another tenant reads as unknown, and that tenant’s row is untouched', async () => {
    const twinBefore = await membershipRow(world.twin.owner.membershipId);
    const session = await signIn(world.northstar.owner.id);
    // Maya Hasan is the twin's owner, with an organization id one hex digit from this one.
    const response = await send('PATCH', `/members/${world.twin.owner.id}/role`, session, {
      role: 'member',
    });
    expect(response.statusCode).toBe(404);
    expect(await membershipRow(world.twin.owner.membershipId)).toEqual(twinBefore);

    // And the twin's owner, through their own slug, cannot re-role a Northstar member.
    const twin = await signIn(world.twin.owner.id);
    const across = await send(
      'PATCH',
      `/members/${world.northstar.designer.id}/role`,
      twin,
      { role: 'manager' },
      'northstar-studios',
    );
    expect(across.statusCode).toBe(404);
    expect((await membershipRow(world.northstar.designer.membershipId))?.['role']).toBe('member');
    expect(await auditRows('membership.role_changed')).toHaveLength(0);
  });
});

describe('SEC-011 (7ab342c2): no owner exemption on a custom role carrying approval.decide', () => {
  async function seedRole(name: string, capabilities: readonly string[]): Promise<string> {
    const id = uuidv7();
    await db.admin.execute(
      `insert into custom_roles (id, organization_id, name, capabilities_json, created_by, created_at)
       values (?, ?, ?, ?, ?, ?)`,
      [
        id,
        world.northstar.organizationId,
        name,
        JSON.stringify(capabilities),
        world.northstar.owner.id,
        new Date('2026-09-01T00:00:00.000Z'),
      ],
    );
    return id;
  }

  it('the owner’s bulk assign of a reviewer-gated custom role is a 403 with no write', async () => {
    const roleId = await seedRole('Org-wide approvers', ['work.read', 'approval.decide']);
    const session = await signIn(world.northstar.owner.id);
    const response = await send('POST', '/admin/members/bulk-role', session, {
      roleId,
      membershipIds: [world.northstar.designer.membershipId],
    });
    expect(response.statusCode).toBe(403);
    expect((await membershipRow(world.northstar.designer.membershipId))?.['role']).toBe('member');
    expect(await auditRows('membership.role_changed')).toHaveLength(0);
  });

  it('the same owner’s bulk assign of a held capability subset lands and is audited', async () => {
    // The control: the refusal above is about approval.decide, not about bulk assign as such.
    const roleId = await seedRole('Readers', ['work.read']);
    const session = await signIn(world.northstar.owner.id);
    const response = await send('POST', '/admin/members/bulk-role', session, {
      roleId,
      membershipIds: [world.northstar.designer.membershipId],
    });
    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({
      assignments: [{ membershipId: world.northstar.designer.membershipId, outcome: 'assigned' }],
    });
    expect((await membershipRow(world.northstar.designer.membershipId))?.['role']).toBe(roleId);
    expect(await auditRows('membership.role_changed')).toHaveLength(1);
  });
});

describe('Q4: an org admin sends a member a password reset link', () => {
  const reason = 'Locked out after a phone change';

  it('audits first, with identifiers only, and mails the member the ordinary link', async () => {
    const designer = world.northstar.designer;
    const session = await signIn(world.northstar.owner.id);
    const response = await send(
      'POST',
      `/members/${designer.membershipId}/password-reset`,
      session,
      {
        reason,
      },
    );
    expect(response.statusCode).toBe(202);
    expect(response.json()).toEqual({ status: 'sent' });
    // The admin never sees the link or the address.
    expect(response.body).not.toContain(designer.email);

    const events = await auditRows('member.password_reset_sent');
    expect(events).toHaveLength(1);
    expect(events[0]?.['organization_id']).toBe(world.northstar.organizationId);
    expect(events[0]?.['actor_user_id']).toBe(world.northstar.owner.id);
    expect(events[0]?.['object_id']).toBe(designer.membershipId);
    const metadata = metadataOf(events[0]?.['metadata_json']);
    expect(metadata).toEqual({ target_user_id: designer.id });
    expect(JSON.stringify(metadata)).not.toContain(reason);

    expect(await resetTokensFor(designer.id)).toHaveLength(1);
    await settledMail();
    expect(transport.messages.map((m) => m.to)).toEqual([designer.email]);
  });

  it('refuses the caller’s own membership: that is Forgot password', async () => {
    const owner = world.northstar.owner;
    const session = await signIn(owner.id);
    const response = await send('POST', `/members/${owner.membershipId}/password-reset`, session, {
      reason,
    });
    expect(response.statusCode).toBe(422);
    expect(await auditRows('member.password_reset_sent')).toHaveLength(0);
    expect(await resetTokensFor(owner.id)).toHaveLength(0);
  });

  it('refuses a member who is not active', async () => {
    const leaver = world.northstar.offboardee;
    await db.admin.execute(`update memberships set status = 'suspended' where id = ?`, [
      leaver.membershipId,
    ]);
    const session = await signIn(world.northstar.owner.id);
    const response = await send('POST', `/members/${leaver.membershipId}/password-reset`, session, {
      reason,
    });
    expect(response.statusCode).toBe(422);
    expect(await resetTokensFor(leaver.id)).toHaveLength(0);
    expect(await auditRows('member.password_reset_sent')).toHaveLength(0);
  });

  it('refuses a missing reason before reading anything', async () => {
    const session = await signIn(world.northstar.owner.id);
    const response = await send(
      'POST',
      `/members/${world.northstar.designer.membershipId}/password-reset`,
      session,
      { reason: ' ' },
    );
    expect(response.statusCode).toBe(422);
    expect(await resetTokensFor(world.northstar.designer.id)).toHaveLength(0);
  });

  it('refuses a manager and a client person (no org.manage), issuing no link', async () => {
    const target = world.northstar.designer;
    for (const caller of [world.northstar.manager.id, world.atlas.admin.id]) {
      const session = await signIn(caller);
      const response = await send(
        'POST',
        `/members/${target.membershipId}/password-reset`,
        session,
        {
          reason,
        },
      );
      expect([403, 404]).toContain(response.statusCode);
    }
    expect(await resetTokensFor(target.id)).toHaveLength(0);
    expect(await auditRows('member.password_reset_sent')).toHaveLength(0);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(transport.messages).toHaveLength(0);
  });

  it('a membership of another tenant reads as unknown, and its person gets nothing', async () => {
    const twinOwner = world.twin.owner;
    const session = await signIn(world.northstar.owner.id);
    const response = await send(
      'POST',
      `/members/${twinOwner.membershipId}/password-reset`,
      session,
      {
        reason,
      },
    );
    expect(response.statusCode).toBe(404);
    expect(await resetTokensFor(twinOwner.id)).toHaveLength(0);
    expect(await auditRows('member.password_reset_sent')).toHaveLength(0);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(transport.messages).toHaveLength(0);
  });
});

describe('me/profile: the caller’s own card', () => {
  async function profileRow(organizationId: string, userId: string) {
    const rows = await observe(
      'select job_title from member_profiles where organization_id = ? and user_id = ?',
      [organizationId, userId],
    );
    return rows[0];
  }

  it('reads the caller’s own name, sign-in email and an unset job title', async () => {
    const designer = world.northstar.designer;
    const session = await signIn(designer.id);
    const response = await send('GET', '/me/profile', session);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      displayName: designer.displayName,
      email: designer.email,
      jobTitle: null,
    });
  });

  it('saves the name globally and the title in this studio, audits which changed, ignores email', async () => {
    const designer = world.northstar.designer;
    const session = await signIn(designer.id);
    const response = await send('PUT', '/me/profile', session, {
      displayName: '  Lina S. Samir ',
      jobTitle: 'Art director',
      email: 'attacker@evil.example',
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      displayName: 'Lina S. Samir',
      email: designer.email,
      jobTitle: 'Art director',
    });

    const users = await observe('select display_name, email from users where id = ?', [
      designer.id,
    ]);
    expect(users[0]?.['display_name']).toBe('Lina S. Samir');
    expect(users[0]?.['email']).toBe(designer.email);
    expect((await profileRow(world.northstar.organizationId, designer.id))?.['job_title']).toBe(
      'Art director',
    );

    const events = await auditRows('member.profile_updated');
    expect(events).toHaveLength(1);
    expect(events[0]?.['actor_user_id']).toBe(designer.id);
    expect(events[0]?.['object_id']).toBe(designer.membershipId);
    const metadata = metadataOf(events[0]?.['metadata_json']);
    expect(metadata).toEqual({ name_changed: true, job_changed: true });
    expect(JSON.stringify(metadata)).not.toContain('Art director');

    // Saving the same card again changes nothing and records nothing.
    const again = await send('PUT', '/me/profile', session, {
      displayName: 'Lina S. Samir',
      jobTitle: 'Art director',
    });
    expect(again.statusCode).toBe(200);
    expect(await auditRows('member.profile_updated')).toHaveLength(1);
  });

  it('keeps the job title tenant-local: a second studio sees the shared name, not the title', async () => {
    const designer = world.northstar.designer;
    // Lina also freelances for BrightOps.
    await db.admin.execute(
      `insert into memberships (id, organization_id, user_id, role, has_org_wide_scope)
       values (?, ?, ?, 'member', 0)`,
      [uuidv7(), world.brightops.organizationId, designer.id],
    );
    const session = await signIn(designer.id);
    expect(
      (
        await send('PUT', '/me/profile', session, {
          displayName: 'Lina Samir',
          jobTitle: 'Art director',
        })
      ).statusCode,
    ).toBe(200);

    const there = await send('GET', '/me/profile', session, undefined, 'brightops-consulting');
    expect(there.statusCode).toBe(200);
    expect(there.json()).toEqual({
      displayName: 'Lina Samir',
      email: designer.email,
      jobTitle: null,
    });
    expect(await profileRow(world.brightops.organizationId, designer.id)).toBeUndefined();
    // The audit row is this studio's, not BrightOps'.
    const events = await auditRows('member.profile_updated');
    expect(events.map((e) => e['organization_id'])).toEqual([world.northstar.organizationId]);
  });

  it('refuses an invalid card with every problem named, and writes nothing', async () => {
    const designer = world.northstar.designer;
    const session = await signIn(designer.id);
    const response = await send('PUT', '/me/profile', session, {
      displayName: '   ',
      jobTitle: 'x'.repeat(121),
    });
    expect(response.statusCode).toBe(400);
    const fields = (
      response.json<{ error: { details?: { field: string }[] } }>().error.details ?? []
    ).map((d) => d.field);
    expect(fields.sort()).toEqual(['displayName', 'jobTitle']);
    const users = await observe('select display_name from users where id = ?', [designer.id]);
    expect(users[0]?.['display_name']).toBe(designer.displayName);
    expect(await profileRow(world.northstar.organizationId, designer.id)).toBeUndefined();
    expect(await auditRows('member.profile_updated')).toHaveLength(0);
  });

  it('refuses a client person and a slug the caller has no membership in', async () => {
    const client = await signIn(world.atlas.reviewer.id);
    expect((await send('GET', '/me/profile', client)).statusCode).toBe(403);

    const session = await signIn(world.northstar.designer.id);
    const foreign = await send(
      'PUT',
      '/me/profile',
      session,
      { displayName: 'Renamed from outside', jobTitle: 'Spy' },
      'northstar-studios',
    );
    expect(foreign.statusCode).toBe(404);
    const users = await observe('select display_name from users where id = ?', [
      world.northstar.designer.id,
    ]);
    expect(users[0]?.['display_name']).toBe(world.northstar.designer.displayName);
    expect(await auditRows('member.profile_updated')).toHaveLength(0);
  });
});
