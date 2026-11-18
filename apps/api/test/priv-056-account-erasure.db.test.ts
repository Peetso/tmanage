import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { capabilitiesFor, uuidv7 } from '@tmanage/domain';
import { TenantDatabase, createTenantContext } from '../src/common/database/tenant-context.js';
import { AccountErasure, erasedEmail } from '../src/modules/privacy/privacy-erasure.repository.js';
import { startTestDatabase, truncateAll } from './support/test-database.js';
import type { TestDatabase } from './support/test-database.js';
import { seedTwoTenants } from './seed-two-tenants.js';
import type { SeedWorld } from './seed-two-tenants.js';

/**
 * 56-18 / ACCOUNTFIX at the engine: the account erasure runs to the end on MariaDB, with the
 * append-only triggers of the refresh-token ledger and the sign-in log in force (0378). Before
 * 0378 both refused the erasure on every server and the request waited forever. The rest of
 * each log stays append-only, for every credential.
 */

let db: TestDatabase;
let world: SeedWorld;
let tenant: TenantDatabase;

const context = () =>
  createTenantContext({
    organizationId: world.northstar.organizationId,
    userId: world.northstar.owner.id,
    membershipId: world.northstar.owner.membershipId,
    principalKind: 'internal',
    capabilities: capabilitiesFor('owner'),
    policyVersion: '2026-11-18',
    correlationId: uuidv7(),
  });

/** A session with one superseded refresh token, and one sign-in event, for `userId`. */
async function signedIn(
  userId: string,
): Promise<{ session: string; token: string; event: string }> {
  const session = uuidv7();
  const token = uuidv7();
  const event = uuidv7();
  await db.admin.execute(
    `insert into sessions (id, user_id, refresh_token_hash, user_agent, expires_at, created_at)
     values (?, ?, ?, 'vitest', date_add(now(3), interval 1 day), now(3))`,
    [session, userId, randomBytes(32).toString('hex')],
  );
  await db.admin.execute(
    `insert into session_refresh_tokens (id, session_id, token_hash, issued_at, superseded_at)
     values (?, ?, ?, now(3), now(3))`,
    [token, session, randomBytes(32).toString('hex')],
  );
  await db.admin.execute(
    `insert into authentication_events
       (id, user_id, action, outcome, reason, ip, user_agent, client_hints, occurred_at)
     values (?, ?, 'password_sign_in', 'succeeded', null, '203.0.113.7', 'vitest', 'brand', now(3))`,
    [event, userId],
  );
  return { session, token, event };
}

const one = async (sql: string, params: string[]) =>
  ((await db.admin.query(sql, params)) as unknown as [Record<string, unknown>[]])[0][0];

beforeAll(async () => {
  db = await startTestDatabase();
  tenant = new TenantDatabase(db.runtime, { guardMode: 'enforce' });
}, 300_000);
beforeEach(async () => {
  await truncateAll(db.admin);
  world = await seedTwoTenants(db.admin);
});
afterAll(async () => db.stop());

describe('56-18 account erasure at the engine (0378)', () => {
  it('erases a person who belongs nowhere: sessions gone, sign-in log kept without IP or agent', async () => {
    const person = world.northstar.offboardee;
    const rows = await signedIn(person.id);
    await db.admin.execute(`update memberships set status = 'offboarded' where user_id = ?`, [
      person.id,
    ]);

    const outcome = await new AccountErasure(tenant).run(context(), person.id);

    expect(outcome.global).toBe('erased');
    expect(await one('select email from users where id = ?', [person.id])).toEqual({
      email: erasedEmail(person.id),
    });
    expect(await one('select count(*) as c from sessions where user_id = ?', [person.id])).toEqual({
      c: 0,
    });
    expect(
      await one('select count(*) as c from session_refresh_tokens where id = ?', [rows.token]),
    ).toEqual({ c: 0 });
    expect(
      await one(
        `select action, outcome, ip, user_agent, client_hints
           from authentication_events where id = ?`,
        [rows.event],
      ),
    ).toEqual({
      action: 'password_sign_in',
      outcome: 'succeeded',
      ip: null,
      user_agent: null,
      client_hints: null,
    });
  });

  it('keeps both logs append-only for a live account, and beyond the redaction for an erased one', async () => {
    const live = await signedIn(world.northstar.manager.id);
    await expect(
      db.admin.query('delete from session_refresh_tokens where id = ?', [live.token]),
    ).rejects.toThrow(/append-only/);
    await expect(
      db.admin.query('update authentication_events set ip = null where id = ?', [live.event]),
    ).rejects.toThrow(/append-only/);

    const person = world.northstar.offboardee;
    const erased = await signedIn(person.id);
    await db.admin.execute(`update users set email = ?, disabled_at = now(3) where id = ?`, [
      erasedEmail(person.id),
      person.id,
    ]);
    await expect(
      db.admin.query('update authentication_events set outcome = ? where id = ?', [
        'failed',
        erased.event,
      ]),
    ).rejects.toThrow(/append-only/);
    await expect(
      db.admin.query('delete from authentication_events where id = ?', [erased.event]),
    ).rejects.toThrow(/append-only/);
    await expect(
      db.admin.query('update session_refresh_tokens set superseded_at = now(3) where id = ?', [
        erased.token,
      ]),
    ).rejects.toThrow(/append-only/);
  });
});
