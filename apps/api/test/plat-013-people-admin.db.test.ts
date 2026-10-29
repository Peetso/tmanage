import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RowDataPacket } from 'mysql2/promise';
import { PLATFORM_PERMISSIONS, uuidv7 } from '@tmanage/domain';
import { parseSeedKeys } from '@tmanage/config';
import { TenantDatabase } from '../src/common/database/tenant-context.js';
import { CredentialsRepository } from '../src/modules/identity/credentials.repository.js';
import { createSeedCipher } from '../src/modules/identity/seed-cipher.js';
import { SessionsRepository } from '../src/modules/identity/sessions.repository.js';
import { PlatformAdminRepository } from '../src/modules/platform-admin/platform-admin.repository.js';
import type { PlatformAdminActor } from '../src/modules/platform-admin/platform-admin.guard.js';
import { PlatformPeopleRepository } from '../src/modules/platform-admin/people/people.repository.js';
import { PlatformPeopleService } from '../src/modules/platform-admin/people/people.service.js';
import { startTestDatabase, truncateAll } from './support/test-database.js';
import type { TestDatabase } from './support/test-database.js';
import { seedTwoTenants } from './seed-two-tenants.js';
import type { SeedWorld } from './seed-two-tenants.js';

/**
 * PLAT-013 against a real server — People (platform-admin v2, PA-06, 0247).
 *
 * 1. The B1 list runs on the metadata path over real rows: browse all, filter by organization,
 *    search by email, status.
 * 2. A taken email is a 409 and changes nothing; a new email clears `email_verified_at`, ends
 *    every session and queues the `email_changed` notice, with the platform audit row.
 * 3. Ending one session ends only that one, and only when it is this person's.
 * 4. Reset two-step disables every factor and revokes every unused recovery code, requires
 *    two-step at the next sign-in, and queues `mfa_factor_disabled`.
 * 5. Disable stamps `disabled_at`/`disabled_reason`, ends every session and is what the session
 *    check reads as the account's standing; enable clears it. No DELETE anywhere.
 */

let db: TestDatabase;
let world: SeedWorld;
let tenant: TenantDatabase;
let service: PlatformPeopleService;
const resets: string[] = [];
const notices: { oldEmail: string; newEmail: string }[] = [];

const correlationId = '0199aa00-0000-7000-8000-00000000c013';
const ctx = { correlationId, ip: '203.0.113.13', userAgent: 'Firefox/131' };
const REASON = 'Ticket #4821 — owner asked';
const CIPHER = createSeedCipher(parseSeedKeys(`1:${Buffer.alloc(32, 0x13).toString('base64url')}`));

async function observe(sql: string, params: readonly unknown[] = []): Promise<RowDataPacket[]> {
  const [rows] = await db.admin.query<RowDataPacket[]>(sql, params as unknown[]);
  return rows;
}

function actor(): PlatformAdminActor {
  return {
    account: {
      userId: world.platformAdmin.id,
      email: world.platformAdmin.email,
      displayName: 'Peter',
      emailVerified: true,
      mfaEnabled: true,
    },
    sessionId: uuidv7(),
    stepUp: null,
    source: 'env',
    preset: 'super_admin',
    permissions: [...PLATFORM_PERMISSIONS],
  };
}

async function liveSession(userId: string): Promise<string> {
  const id = uuidv7();
  await db.admin.query(
    `insert into sessions (id, user_id, refresh_token_hash, user_agent, expires_at, created_at, ip_first, ip_last)
     values (?, ?, ?, 'Chrome/130 Windows', date_add(now(3), interval 30 day), now(3), '41.33.10.8', '41.33.10.8')`,
    [id, userId, id.replace(/-/gu, '').padEnd(64, '0')],
  );
  return id;
}

async function factorAndCodes(userId: string): Promise<void> {
  await db.admin.query(
    `insert into user_mfa_factors (id, user_id, kind, label, secret, confirmed_at, created_at)
     values (?, ?, 'totp', 'Phone', 'mfa1.test-envelope', now(3), now(3))`,
    [uuidv7(), userId],
  );
  const batch = uuidv7();
  for (let i = 0; i < 3; i += 1) {
    const id = uuidv7();
    await db.admin.query(
      `insert into user_recovery_codes (id, user_id, batch_id, code_hash, created_at)
       values (?, ?, ?, ?, now(3))`,
      [id, userId, batch, id.replace(/-/gu, '').padEnd(64, 'a')],
    );
  }
}

beforeAll(async () => {
  db = await startTestDatabase();
  await truncateAll(db.admin);
  world = await seedTwoTenants(db.admin);
  tenant = new TenantDatabase(db.runtime, { guardMode: 'enforce' });
  service = new PlatformPeopleService(
    new PlatformAdminRepository(tenant),
    new PlatformPeopleRepository(tenant, new CredentialsRepository(CIPHER)),
    {
      request: async (email: unknown) => {
        resets.push(String(email));
        return {};
      },
    },
    {
      notify: async (input) => {
        notices.push({ oldEmail: input.oldEmail, newEmail: input.newEmail });
        return {};
      },
    },
  );
});

afterAll(async () => {
  await db?.stop();
});

describe('B1 list (metadata path)', () => {
  it('browse all lists every account, the operator included', async () => {
    const view = await service.list({ status: 'any', limit: '100' }, ctx);
    const ids = view.people.map((person) => person.id);
    expect(ids).toContain(world.northstar.designer.id);
    expect(ids).toContain(world.platformAdmin.id);
    expect(view.total).toBeGreaterThanOrEqual(ids.length);
  });

  it('filters by organization and carries the membership chips', async () => {
    const view = await service.list(
      { organizationId: world.northstar.organizationId, limit: '100' },
      ctx,
    );
    const ids = view.people.map((person) => person.id);
    expect(ids).toContain(world.northstar.owner.id);
    expect(ids).not.toContain(world.brightops.owner.id);
    expect(ids).not.toContain(world.platformAdmin.id);
    const owner = view.people.find((person) => person.id === world.northstar.owner.id);
    expect(owner?.companies.map((company) => company.id)).toContain(world.northstar.organizationId);
  });

  it('searches by email', async () => {
    const view = await service.list({ q: world.northstar.designer.email }, ctx);
    expect(view.people.map((person) => person.email)).toEqual([world.northstar.designer.email]);
  });
});

describe('B2 profile', () => {
  it('a taken email is a 409 and changes nothing', async () => {
    const target = world.northstar.designer;
    await expect(
      service.updateProfile(actor(), target.id, { email: world.northstar.owner.email }, ctx),
    ).rejects.toMatchObject({ status: 409 });
    const [row] = await observe('select email, email_verified_at from users where id = ?', [
      target.id,
    ]);
    expect(row?.['email']).toBe(target.email);
  });

  it('a new email clears verification, ends sessions, queues the notice and audits', async () => {
    const target = world.northstar.designer;
    const session = await liveSession(target.id);
    const next = 'designer.new@northstar.test';
    const view = await service.updateProfile(
      actor(),
      target.id,
      { email: next, reason: REASON },
      ctx,
    );
    expect(view.email).toBe(next);
    expect(view.emailVerified).toBe(false);
    const [ended] = await observe('select revoked_at, revoked_reason from sessions where id = ?', [
      session,
    ]);
    expect(ended?.['revoked_at']).not.toBeNull();
    expect(ended?.['revoked_reason']).toBe('platform_admin_email_changed');
    const queued = await observe(
      `select action from credential_change_notices where user_id = ? and action = 'email_changed'`,
      [target.id],
    );
    expect(queued).toHaveLength(1);
    const [audit] = await observe(
      `select reason, ip, before_json, after_json from platform_admin_audit_events
        where action = 'platform.user_profile_updated' and target_id = ?`,
      [target.id],
    );
    expect(audit).toMatchObject({ reason: REASON, ip: '203.0.113.13' });
    expect(JSON.parse(String(audit?.['before_json'])).email).toBe(target.email);
    expect(resets).toContain(next);
    expect(notices).toContainEqual({ oldEmail: target.email, newEmail: next });
  });
});

describe('B3 security', () => {
  it('ends one session only, and only when it is this person’s', async () => {
    const target = world.northstar.manager;
    const keep = await liveSession(target.id);
    const end = await liveSession(target.id);
    const other = await liveSession(world.northstar.owner.id);
    await expect(
      service.endSession(actor(), target.id, other, { reason: REASON }, ctx),
    ).rejects.toMatchObject({ status: 404 });
    await service.endSession(actor(), target.id, end, { reason: REASON }, ctx);
    const rows = await observe('select id, revoked_at from sessions where id in (?, ?, ?)', [
      keep,
      end,
      other,
    ]);
    const revoked = new Map(rows.map((row) => [String(row['id']), row['revoked_at'] !== null]));
    expect(revoked.get(end)).toBe(true);
    expect(revoked.get(keep)).toBe(false);
    expect(revoked.get(other)).toBe(false);
  });

  it('reset two-step disables factors and revokes recovery codes, then requires enrolment', async () => {
    const target = world.northstar.manager;
    await factorAndCodes(target.id);
    await expect(service.resetTwoStep(actor(), target.id, {}, ctx)).rejects.toMatchObject({
      status: 400,
    });
    const result = await service.resetTwoStep(
      actor(),
      target.id,
      { reason: REASON, signOut: false },
      ctx,
    );
    expect(result.person.mfaEnabled).toBe(false);
    expect(result.person.twoStepRequired).toBe(true);
    expect(result.sessionsEnded).toBe(0);
    const live = await observe(
      'select count(*) as n from user_mfa_factors where user_id = ? and disabled_at is null',
      [target.id],
    );
    expect(Number(live[0]?.['n'])).toBe(0);
    const codes = await observe(
      'select count(*) as n from user_recovery_codes where user_id = ? and revoked_at is null',
      [target.id],
    );
    expect(Number(codes[0]?.['n'])).toBe(0);
    const queued = await observe(
      `select action from credential_change_notices where user_id = ? and action = 'mfa_factor_disabled'`,
      [target.id],
    );
    expect(queued).toHaveLength(1);
    // The session that was kept stays live: "Also sign her out" was not ticked.
    const sessions = await observe(
      'select count(*) as n from sessions where user_id = ? and revoked_at is null',
      [target.id],
    );
    expect(Number(sessions[0]?.['n'])).toBe(1);
  });

  it('disable needs a reason, blocks the standing and ends sessions; enable clears it', async () => {
    const target = world.northstar.offboardee;
    const session = await liveSession(target.id);
    await expect(service.disable(actor(), target.id, {}, ctx)).rejects.toMatchObject({
      status: 400,
    });
    const disabled = await service.disable(actor(), target.id, { reason: REASON }, ctx);
    expect(disabled.person.status).toBe('disabled');
    expect(disabled.person.disabledReason).toBe(REASON);
    expect(disabled.person.disabledByEmail).toBe(world.platformAdmin.email);
    expect(disabled.sessionsEnded).toBe(1);
    const [ended] = await observe('select revoked_reason from sessions where id = ?', [session]);
    expect(ended?.['revoked_reason']).toBe('platform_admin_disabled');

    const standing = await tenant.identityRead({ correlationId, tables: ['users'] }, (runner) =>
      new SessionsRepository().findStanding(runner, target.id),
    );
    expect(standing?.disabledAt).toBeInstanceOf(Date);

    const filtered = await service.list({ status: 'disabled', limit: '100' }, ctx);
    expect(filtered.people.map((person) => person.id)).toContain(target.id);

    const enabled = await service.enable(actor(), target.id, {}, ctx);
    expect(enabled.status).toBe('active');
    const [row] = await observe('select disabled_at, disabled_reason from users where id = ?', [
      target.id,
    ]);
    expect(row).toMatchObject({ disabled_at: null, disabled_reason: null });
    const audits = await observe(
      `select action from platform_admin_audit_events where target_id = ? order by created_at, id`,
      [target.id],
    );
    expect(audits.map((audit) => audit['action'])).toEqual([
      'platform.user_disabled',
      'platform.user_enabled',
    ]);
  });
});
