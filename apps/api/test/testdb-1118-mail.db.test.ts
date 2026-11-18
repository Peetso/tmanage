import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RowDataPacket } from 'mysql2/promise';
import { uuidv7 } from '@tmanage/domain';
import { bounceMessageId, deriveBounceKey, emailAddressHash } from '@tmanage/mail';
import type { MailMessage } from '@tmanage/mail';
import { createWorkerDatabase } from '@tmanage/worker';
import type { WorkerDatabase } from '@tmanage/worker';
import { TenantDatabase } from '../src/common/database/tenant-context.js';
import {
  MailBounceLookup,
  MailBouncesService,
} from '../src/modules/mail-bounces/mail-bounces.service.js';
import { startTestDatabase } from './support/test-database.js';
import type { TestDatabase } from './support/test-database.js';
import { seedTwoTenants } from './seed-two-tenants.js';
import type { SeedWorld } from './seed-two-tenants.js';

/**
 * TESTDB 2026-11-18 — the mail tables of migrations 0366 / 0370 / 0371 / 0372 / 0373 / 0374 on
 * the real engine (MariaDB 11.8), through the real repositories and the worker's real stores.
 *
 * - 56-26 bounces: the signed intake counts a hard bounce once and suppresses; three soft bounces
 *   of three messages suppress; an ARF complaint (`last_kind = 'complaint'`, nine characters — the
 *   0370 widening) suppresses; the guard (API and worker lookups) answers per company; an admin's
 *   clear lifts it. The worker's SMTP refusal recorder writes the same row.
 * - EMAILBUILD mail people: the 0371 seed plus the 0372 rename; the less-loaded person of the pair
 *   is assigned and kept; a person switched off is replaced once.
 * - EMAILBUILD2 / MAILREST person mail: the tips switch (absent = off) stops everything; the claim
 *   is once per (user, tip); a failed send goes to 'retry' and is sent by a later run as attempt 2;
 *   a reclaim race has one winner; 'gave_up' is final; the "Tips" preference row is read.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const workerModule = async <T>(path: string): Promise<T> =>
  (await import(pathToFileURL(resolve(HERE, '../../worker/src', path)).href)) as T;

interface BounceRefusalModule {
  createBounceRefusalRecorder(database: WorkerDatabase): {
    recordRefusal(input: {
      organizationId: string;
      addressHash: string;
      refusal: { kind: 'hard' | 'soft'; status: string };
      reference: string;
      at: Date;
    }): Promise<void>;
  };
}
interface BounceSuppressionModule {
  createBounceSuppressionLookup(database: WorkerDatabase): {
    isBounceSuppressed(organizationId: string, addressHash: string): Promise<boolean>;
  };
}
interface MailPeopleModule {
  createMailPeopleDirectory(
    database: WorkerDatabase,
    options?: { now?: () => Date },
  ): {
    personFor(
      organizationId: string | undefined,
      ref: { kind: 'assigned'; userId: string; topic: string },
      language: 'en' | 'ar',
    ): Promise<{ name: string; role: string; address: string } | null>;
  };
}
interface Candidate {
  readonly organizationId: string;
  readonly membershipId: string;
  readonly userId: string;
  readonly role: string;
  readonly email: string;
  readonly displayName: string;
  readonly locale: string | null;
  readonly slug: string;
  readonly workspaceName: string;
}
type Outcome =
  | { status: 'sent' }
  | { status: 'retry'; nextAttemptAt: Date; error: string }
  | { status: 'gave_up'; error: string };
interface PersonMailStore {
  tipsSwitchOn(): Promise<boolean>;
  listCandidates(after: string | null, limit: number): Promise<readonly Candidate[]>;
  memberFacts(candidate: Candidate, now: Date): Promise<{ tipsEnabled: boolean }>;
  claim(candidate: Candidate, tipId: string, at: Date): Promise<boolean>;
  dueRetries(
    now: Date,
    limit: number,
  ): Promise<readonly { candidate: Candidate; tipId: string; attempts: number }[]>;
  reclaim(
    retry: { candidate: Candidate; tipId: string; attempts: number },
    at: Date,
  ): Promise<boolean>;
  settle(
    candidate: Candidate,
    tipId: string,
    attempts: number,
    outcome: Outcome,
    at: Date,
  ): Promise<void>;
}
interface PersonMailStoreModule {
  createPersonMailStore(database: WorkerDatabase): PersonMailStore;
}
interface SweepModule {
  sweepPersonMail(deps: {
    store: PersonMailStore;
    mailer: { send(message: MailMessage): Promise<'sent' | 'none'> } | null;
    webOrigin: string;
    now: Date;
    batch?: number;
  }): Promise<{ looked: number; sent: number; wrapped: boolean }>;
}

const KEY = deriveBounceKey('t'.repeat(48));
const AT = new Date('2026-11-18T09:00:00.000Z');
const noAudit = { record: vi.fn(() => Promise.resolve({})) } as unknown as ConstructorParameters<
  typeof MailBouncesService
>[2];

let db: TestDatabase;
let world: SeedWorld;
let tenant: TenantDatabase;
let workerDb: WorkerDatabase;

async function rows(sql: string, params: unknown[] = []): Promise<RowDataPacket[]> {
  const [result] = await db.admin.query<RowDataPacket[]>(sql, params);
  return result;
}

function dsn(messageId: string, status: string): Buffer {
  return Buffer.from(
    [
      'Content-Type: multipart/report; report-type=delivery-status; boundary="b"',
      '',
      '--b',
      'Content-Type: message/delivery-status',
      '',
      'Reporting-MTA: dns; mx.example',
      '',
      'Final-Recipient: rfc822; whoever@elsewhere.example',
      'Action: failed',
      `Status: ${status}`,
      '',
      '--b',
      'Content-Type: text/rfc822-headers',
      '',
      `Message-ID: ${messageId}`,
      '--b--',
    ].join('\r\n'),
  );
}

function complaint(messageId: string): Buffer {
  return Buffer.from(
    [
      'Content-Type: multipart/report; report-type=feedback-report; boundary="fb"',
      '',
      '--fb',
      'Content-Type: message/feedback-report',
      '',
      'Feedback-Type: abuse',
      'Version: 1',
      '',
      '--fb',
      'Content-Type: text/rfc822-headers',
      '',
      `Message-ID: ${messageId}`,
      '--fb--',
    ].join('\r\n'),
  );
}

const signedId = (organizationId: string, to: string): string =>
  bounceMessageId(KEY, { organizationId, to, domain: 'tm.example' }) as string;

beforeAll(async () => {
  db = await startTestDatabase();
  tenant = new TenantDatabase(db.runtime, { guardMode: 'enforce' });
  workerDb = createWorkerDatabase({ url: db.url, connectionLimit: 3, statementTimeoutMs: 15_000 });
  world = await seedTwoTenants(db.admin);
});

afterAll(async () => {
  await workerDb?.end();
  await db?.stop();
});

describe('56-26 bounce and complaint suppression (0366, 0370)', () => {
  beforeEach(async () => {
    await db.admin.query('DELETE FROM mail_recipient_bounces');
  });

  it('a hard bounce suppresses at once; the same report again counts once', async () => {
    const org = world.northstar.organizationId;
    const to = 'ann@client.example';
    const service = new MailBouncesService(tenant, KEY, noAudit, undefined, () => AT);
    // One sent message (one signed id); its report arrives twice.
    const sent = signedId(org, to);
    await expect(service.record(dsn(sent, '5.1.1'), uuidv7())).resolves.toBe('suppressed');
    await expect(service.record(dsn(sent, '5.1.1'), uuidv7())).resolves.toBe('duplicate');
    const stored = await rows(
      'SELECT hard_count, soft_count, last_kind, suppressed_at FROM mail_recipient_bounces WHERE organization_id = ? AND address_hash = ?',
      [org, emailAddressHash(to)],
    );
    expect(stored).toHaveLength(1);
    expect(Number(stored[0]?.['hard_count'])).toBe(1);
    expect(stored[0]?.['last_kind']).toBe('hard');
    expect(stored[0]?.['suppressed_at']).not.toBeNull();
    // The guard is per company: the twin workspace still mails the same address.
    const lookup = new MailBounceLookup(tenant);
    await expect(lookup.isBounceSuppressed(org, emailAddressHash(to))).resolves.toBe(true);
    await expect(
      lookup.isBounceSuppressed(world.twin.organizationId, emailAddressHash(to)),
    ).resolves.toBe(false);
  });

  it('three soft bounces of three messages suppress; two do not', async () => {
    const org = world.northstar.organizationId;
    const to = 'full.box@client.example';
    let clock = AT;
    const service = new MailBouncesService(tenant, KEY, noAudit, undefined, () => clock);
    // Each signed id carries a fresh nonce, so each is a different message.
    await expect(service.record(dsn(signedId(org, to), '5.2.2'), uuidv7())).resolves.toBe(
      'recorded',
    );
    clock = new Date(AT.getTime() + 60_000);
    await expect(service.record(dsn(signedId(org, to), '5.2.2'), uuidv7())).resolves.toBe(
      'recorded',
    );
    clock = new Date(AT.getTime() + 120_000);
    await expect(service.record(dsn(signedId(org, to), '5.2.2'), uuidv7())).resolves.toBe(
      'suppressed',
    );
    const [row] = await rows(
      'SELECT soft_count, last_kind FROM mail_recipient_bounces WHERE organization_id = ? AND address_hash = ?',
      [org, emailAddressHash(to)],
    );
    expect(Number(row?.['soft_count'])).toBe(3);
    expect(row?.['last_kind']).toBe('soft');
  });

  it("a spam complaint stores last_kind 'complaint' (0370 width) and suppresses; clear lifts it", async () => {
    const org = world.northstar.organizationId;
    const to = 'annoyed@client.example';
    const service = new MailBouncesService(tenant, KEY, noAudit, undefined, () => AT);
    await expect(service.record(complaint(signedId(org, to)), uuidv7())).resolves.toBe(
      'suppressed',
    );
    const [row] = await rows(
      'SELECT last_kind, last_status, suppressed_at FROM mail_recipient_bounces WHERE organization_id = ? AND address_hash = ?',
      [org, emailAddressHash(to)],
    );
    expect(row?.['last_kind']).toBe('complaint');
    expect(row?.['last_status']).toBe('abuse');
    expect(row?.['suppressed_at']).not.toBeNull();

    const lookup = new MailBounceLookup(tenant);
    await expect(lookup.isBounceSuppressed(org, emailAddressHash(to))).resolves.toBe(true);
    const { createTenantContext } = await import('../src/common/database/tenant-context.js');
    const { capabilitiesFor } = await import('@tmanage/domain');
    const owner = world.northstar.owner;
    const context = createTenantContext({
      organizationId: org,
      userId: owner.id,
      membershipId: owner.membershipId,
      principalKind: 'internal',
      capabilities: capabilitiesFor('owner'),
      policyVersion: 'testdb-1118',
      correlationId: uuidv7(),
    });
    const principal = {
      userId: owner.id,
      organizationId: org,
      kind: 'internal',
      role: 'owner',
      membershipId: owner.membershipId,
      membershipStatus: 'active',
      clientOrganizationId: null,
      projectIds: [],
      hasOrgWideScope: true,
    } as unknown as Parameters<MailBouncesService['clear']>[1];
    await expect(service.clear(context, principal, { address: to })).resolves.toMatchObject({
      status: 'clear',
    });
    await expect(lookup.isBounceSuppressed(org, emailAddressHash(to))).resolves.toBe(false);
    const [cleared] = await rows(
      'SELECT hard_count, soft_count, cleared_by_user_id FROM mail_recipient_bounces WHERE organization_id = ? AND address_hash = ?',
      [org, emailAddressHash(to)],
    );
    expect(Number(cleared?.['hard_count'])).toBe(0);
    expect(cleared?.['cleared_by_user_id']).toBe(owner.id);
  });

  it("the worker's SMTP refusal recorder and lookup use the same row (MAILREST)", async () => {
    const { createBounceRefusalRecorder } = await workerModule<BounceRefusalModule>(
      'common/database/bounce-refusal-store.ts',
    );
    const { createBounceSuppressionLookup } = await workerModule<BounceSuppressionModule>(
      'common/database/bounce-suppression-store.ts',
    );
    const recorder = createBounceRefusalRecorder(workerDb);
    const lookup = createBounceSuppressionLookup(workerDb);
    const org = world.brightops.organizationId;
    const hash = emailAddressHash('gone@client.example');
    await recorder.recordRefusal({
      organizationId: org,
      addressHash: hash,
      refusal: { kind: 'soft', status: '5.0.0' },
      reference: 's.aaaaaaaaaaaaaaaa',
      at: AT,
    });
    await expect(lookup.isBounceSuppressed(org, hash)).resolves.toBe(false);
    // The same message refused again is not counted twice.
    await recorder.recordRefusal({
      organizationId: org,
      addressHash: hash,
      refusal: { kind: 'soft', status: '5.0.0' },
      reference: 's.aaaaaaaaaaaaaaaa',
      at: AT,
    });
    await recorder.recordRefusal({
      organizationId: org,
      addressHash: hash,
      refusal: { kind: 'hard', status: '5.1.1' },
      reference: 's.bbbbbbbbbbbbbbbb',
      at: new Date(AT.getTime() + 1000),
    });
    await expect(lookup.isBounceSuppressed(org, hash)).resolves.toBe(true);
    await expect(lookup.isBounceSuppressed(world.northstar.organizationId, hash)).resolves.toBe(
      false,
    );
    const [row] = await rows(
      'SELECT hard_count, soft_count FROM mail_recipient_bounces WHERE organization_id = ? AND address_hash = ?',
      [org, hash],
    );
    expect(Number(row?.['soft_count'])).toBe(1);
    expect(Number(row?.['hard_count'])).toBe(1);
  });
});

describe('EMAILBUILD mail people (0371, 0372)', () => {
  beforeEach(async () => {
    await db.admin.query('DELETE FROM mail_person_assignments');
    await db.admin.query('UPDATE platform_mail_people SET active = 1');
  });

  it('seeds 30 people, two per (region, topic), and 0372 renamed the west onboarding person', async () => {
    const [total] = await rows('SELECT count(*) AS n FROM platform_mail_people');
    expect(Number(total?.['n'])).toBe(30);
    const pairs = await rows(
      'SELECT region, topic, count(*) AS n FROM platform_mail_people GROUP BY region, topic',
    );
    expect(pairs).toHaveLength(15);
    expect(pairs.every((pair) => Number(pair['n']) === 2)).toBe(true);
    const [emily] = await rows(
      "SELECT name_en, address FROM platform_mail_people WHERE id = '939b9670-fb27-508f-84ef-03ef269f3425'",
    );
    expect(emily).toMatchObject({ name_en: 'Emily', address: 'emily@tmanageapp.com' });
  });

  it('assigns the less-loaded person of the pair, keeps them, and replaces one switched off', async () => {
    const { createMailPeopleDirectory } = await workerModule<MailPeopleModule>(
      'common/database/mail-people-store.ts',
    );
    const directory = createMailPeopleDirectory(workerDb, { now: () => AT });
    const org = world.northstar.organizationId;
    // Northstar has no MENA/Asia time zone, so an English reader is in the `west` pair.
    const first = await directory.personFor(
      org,
      { kind: 'assigned', userId: world.northstar.owner.id, topic: 'onboarding' },
      'en',
    );
    const second = await directory.personFor(
      org,
      { kind: 'assigned', userId: world.northstar.manager.id, topic: 'onboarding' },
      'en',
    );
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(new Set([first?.address, second?.address])).toEqual(
      new Set(['daniel@tmanageapp.com', 'emily@tmanageapp.com']),
    );
    // Kept: asking again answers the same person.
    await expect(
      directory.personFor(
        org,
        { kind: 'assigned', userId: world.northstar.owner.id, topic: 'onboarding' },
        'en',
      ),
    ).resolves.toEqual(first);
    // Switched off: replaced once by the other of the pair, and the assignment row moves.
    await db.admin.query('UPDATE platform_mail_people SET active = 0 WHERE address = ?', [
      first?.address,
    ]);
    const replaced = await directory.personFor(
      org,
      { kind: 'assigned', userId: world.northstar.owner.id, topic: 'onboarding' },
      'en',
    );
    expect(replaced?.address).toBe(second?.address);
    const assigned = await rows(
      `SELECT p.address AS address FROM mail_person_assignments a
         JOIN platform_mail_people p ON p.id = a.person_id
        WHERE a.organization_id = ? AND a.user_id = ? AND a.topic = 'onboarding'`,
      [org, world.northstar.owner.id],
    );
    expect(assigned.map((row) => row['address'])).toEqual([second?.address]);
  });
});

describe('EMAILBUILD2 / MAILREST person mail (0373, 0374)', () => {
  // Far enough ahead that every seeded member is past their first day, whatever the server clock.
  const NOW = new Date(Date.now() + 40 * 86_400_000);
  const HOUR = 3_600_000;
  let store: PersonMailStore;
  let sweep: SweepModule['sweepPersonMail'];

  beforeAll(async () => {
    store = (
      await workerModule<PersonMailStoreModule>('common/database/person-mail-store.ts')
    ).createPersonMailStore(workerDb);
    sweep = (await workerModule<SweepModule>('jobs/person-mail-sweep.ts')).sweepPersonMail;
  });

  beforeEach(async () => {
    await db.admin.query('DELETE FROM mail_tip_log');
    await db.admin.query('DELETE FROM platform_feature_news');
    await db.admin.query("DELETE FROM platform_settings WHERE setting_key = 'mail.tips_enabled'");
    await db.admin.query("DELETE FROM notification_kind_prefs WHERE kind = 'tips'");
    await db.admin.query(
      'UPDATE platform_person_mail_sweep SET cursor_user_id = NULL, last_run_at = NULL WHERE id = 1',
    );
  });

  async function switchOn(): Promise<void> {
    await db.admin.query(
      `INSERT INTO platform_settings (setting_key, setting_value, updated_at)
       VALUES ('mail.tips_enabled', 'on', ?)`,
      [NOW],
    );
  }

  async function publishNews(): Promise<void> {
    await db.admin.query(
      `INSERT INTO platform_feature_news
         (id, title_en, title_ar, body_en, body_ar, link, created_by_user_id, created_at, sent_at)
       VALUES (?, 'Timesheets', 'الجداول', 'Log time in one place.', 'سجّل وقتك في مكان واحد.',
               'https://tmanageapp.com/news', ?, ?, ?)`,
      [uuidv7(), world.platformAdmin.id, NOW, new Date(NOW.getTime() - HOUR)],
    );
  }

  it('the switch is off while absent: a run sends nothing and claims nothing', async () => {
    await publishNews();
    await expect(store.tipsSwitchOn()).resolves.toBe(false);
    const send = vi.fn(() => Promise.resolve('sent' as const));
    const result = await sweep({
      store,
      mailer: { send },
      webOrigin: 'https://tm.example',
      now: NOW,
    });
    expect(result.looked).toBeGreaterThan(0);
    expect(result.sent).toBe(0);
    expect(send).not.toHaveBeenCalled();
    const [count] = await rows('SELECT count(*) AS n FROM mail_tip_log');
    expect(Number(count?.['n'])).toBe(0);
  });

  it('a failed send goes to retry; the run after the back-off sends it as attempt 2, once', async () => {
    await switchOn();
    await publishNews();
    const failing = vi.fn(() =>
      Promise.reject(Object.assign(new Error('try later'), { responseCode: 451, command: 'DATA' })),
    );
    const first = await sweep({
      store,
      mailer: { send: failing },
      webOrigin: 'https://tm.example',
      now: NOW,
    });
    expect(first.sent).toBe(0);
    expect(failing).toHaveBeenCalled();
    const retry = await rows(
      'SELECT user_id, tip_id, status, attempts, next_attempt_at, last_error FROM mail_tip_log',
    );
    expect(retry.length).toBe(failing.mock.calls.length);
    for (const row of retry) {
      expect(row['status']).toBe('retry');
      expect(Number(row['attempts'])).toBe(1);
      expect(row['last_error']).toBe('smtp_451');
      expect(row['next_attempt_at']).not.toBeNull();
    }
    // The 1 h back-off, read through the worker's own connection: not due a moment before.
    await expect(store.dueRetries(new Date(NOW.getTime() + HOUR - 1), 25)).resolves.toHaveLength(0);
    await expect(store.dueRetries(new Date(NOW.getTime() + HOUR), 25)).resolves.toHaveLength(
      retry.length,
    );

    const later = new Date(NOW.getTime() + 2 * HOUR);
    const sent: MailMessage[] = [];
    const second = await sweep({
      store,
      mailer: {
        send: (message) => {
          sent.push(message);
          return Promise.resolve('sent');
        },
      },
      webOrigin: 'https://tm.example',
      now: later,
    });
    expect(second.sent).toBe(retry.length);
    const settled = await rows('SELECT status, attempts, last_error FROM mail_tip_log');
    expect(settled).toHaveLength(retry.length);
    for (const row of settled) {
      expect(row['status']).toBe('sent');
      expect(Number(row['attempts'])).toBe(2);
    }
    // One mail per member, never two for the same tip.
    expect(new Set(sent.map((message) => message.to)).size).toBe(sent.length);
  });

  it('a reclaim race has one winner; gave_up is final and never due again', async () => {
    await switchOn();
    const [candidate] = await store.listCandidates(null, 1);
    expect(candidate).toBeDefined();
    const c = candidate as Candidate;
    await expect(store.claim(c, 'tip:testdb-race', NOW)).resolves.toBe(true);
    await expect(store.claim(c, 'tip:testdb-race', NOW)).resolves.toBe(false);
    await store.settle(
      c,
      'tip:testdb-race',
      1,
      { status: 'retry', nextAttemptAt: new Date(NOW.getTime() + HOUR), error: 'smtp_451' },
      NOW,
    );
    const due = await store.dueRetries(new Date(NOW.getTime() + HOUR), 25);
    const mine = due.find((row) => row.tipId === 'tip:testdb-race');
    expect(mine?.attempts).toBe(1);
    const outcomes = await Promise.all([
      store.reclaim(mine as NonNullable<typeof mine>, NOW),
      store.reclaim(mine as NonNullable<typeof mine>, NOW),
    ]);
    expect(outcomes.filter(Boolean)).toHaveLength(1);
    // A settle naming a stale attempt changes nothing.
    await store.settle(c, 'tip:testdb-race', 1, { status: 'sent' }, NOW);
    let [row] = await rows(
      "SELECT status, attempts FROM mail_tip_log WHERE tip_id = 'tip:testdb-race'",
    );
    expect(row).toMatchObject({ status: 'sending' });
    expect(Number(row?.['attempts'])).toBe(2);
    await store.settle(c, 'tip:testdb-race', 2, { status: 'gave_up', error: 'smtp_550' }, NOW);
    [row] = await rows(
      "SELECT status, last_error FROM mail_tip_log WHERE tip_id = 'tip:testdb-race'",
    );
    expect(row).toMatchObject({ status: 'gave_up', last_error: 'smtp_550' });
    await expect(store.dueRetries(new Date(NOW.getTime() + 30 * HOUR), 25)).resolves.toHaveLength(
      0,
    );
  });

  it("the member's 'tips' preference row (0373 ENUM value) turns tips off for that member only", async () => {
    await switchOn();
    const candidates = await store.listCandidates(null, 100);
    const owner = candidates.find((row) => row.userId === world.northstar.owner.id);
    const manager = candidates.find((row) => row.userId === world.northstar.manager.id);
    expect(owner).toBeDefined();
    expect(manager).toBeDefined();
    await db.admin.query(
      `INSERT INTO notification_kind_prefs (id, organization_id, membership_id, kind, enabled, updated_at)
       VALUES (?, ?, ?, 'tips', 0, ?)`,
      [uuidv7(), world.northstar.organizationId, world.northstar.owner.membershipId, NOW],
    );
    await expect(store.memberFacts(owner as Candidate, NOW)).resolves.toMatchObject({
      tipsEnabled: false,
    });
    await expect(store.memberFacts(manager as Candidate, NOW)).resolves.toMatchObject({
      tipsEnabled: true,
    });
  });
});
