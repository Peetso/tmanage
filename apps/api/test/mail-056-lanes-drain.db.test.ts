import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RowDataPacket } from 'mysql2/promise';
import { QueueMailer } from '@tmanage/mail';
import type { MailMessage } from '@tmanage/mail';
import {
  createMailDrainerState,
  createMailQueueStore,
  createWorkerDatabase,
  drainMailOnce,
} from '@tmanage/worker';
import type { WorkerDatabase } from '@tmanage/worker';
import { TABLES } from '../src/common/database/schema.js';
import { isNonTenantTable } from '../src/common/database/tenant-guard.js';
import { startTestDatabase } from './support/test-database.js';
import type { TestDatabase } from './support/test-database.js';

/**
 * 56-31 over the real engine — migration 0256 and the worker's `mail-queue-store.ts`.
 *
 * - INT-56-31: 500 bulk + 20 auth under a 50/h ceiling → every auth row leaves in the first
 *   tick, bulk is deferred (not dropped) and resumes in the next hour window.
 * - INT-56-32: security@ refusing → auth goes out through noreply@, `mail_provider_degraded` once.
 * - REL-13: a claim abandoned between claim and send is not resent by the next drainer; after
 *   the stale window it is re-queued and sent exactly once.
 */

let db: TestDatabase;
let workerDb: WorkerDatabase;
let clock = new Date('2026-10-29T10:05:00.000Z');
const now = (): Date => clock;

function capture(): { sent: MailMessage[]; mailer: { send(m: MailMessage): Promise<'sent'> } } {
  const sent: MailMessage[] = [];
  return {
    sent,
    mailer: {
      send: (message) => {
        sent.push(message);
        return Promise.resolve('sent');
      },
    },
  };
}

async function rows(sql: string, params: unknown[] = []): Promise<RowDataPacket[]> {
  const [result] = await db.admin.query<RowDataPacket[]>(sql, params);
  return result;
}

async function enqueue(count: number, templateKey: string): Promise<void> {
  const mailer = new QueueMailer(createMailQueueStore(workerDb), { now });
  for (let i = 0; i < count; i += 1) {
    await mailer.send({
      to: `${templateKey}-${String(i)}@example.com`,
      subject: templateKey,
      text: 'x',
      templateKey,
    });
  }
}

beforeAll(async () => {
  db = await startTestDatabase();
  workerDb = createWorkerDatabase({ url: db.url, connectionLimit: 2, statementTimeoutMs: 15_000 });
});

afterAll(async () => {
  await workerDb?.end();
  await db?.stop();
});

beforeEach(async () => {
  await db.admin.query('DELETE FROM mail_queue');
  await db.admin.query('DELETE FROM mail_hour_windows');
  await db.admin.query("DELETE FROM platform_settings WHERE setting_key LIKE 'mail\\_%'");
});

describe('56-31 mail lanes against the database', () => {
  it('registers both tables (schema, global)', () => {
    expect(TABLES).toHaveProperty('mail_queue');
    expect(TABLES).toHaveProperty('mail_hour_windows');
    expect(isNonTenantTable('mail_queue')).toBe(true);
    expect(isNonTenantTable('mail_hour_windows')).toBe(true);
  });

  it('INT-56-31: auth first under a 50/h ceiling; bulk deferred, then resumed', async () => {
    clock = new Date('2026-10-29T10:05:00.000Z');
    await db.admin.query(
      `INSERT INTO platform_settings (setting_key, setting_value, updated_at)
       VALUES ('mail_hour_ceiling_noreply', '50', ?)`,
      [clock],
    );
    await enqueue(500, 'announcement');
    await enqueue(20, 'sign_in_code');
    const noreply = capture();
    const state = createMailDrainerState();
    const store = createMailQueueStore(workerDb);
    await drainMailOnce({ store, noreply: noreply.mailer, now }, state);
    expect(noreply.sent.filter((m) => m.subject === 'sign_in_code')).toHaveLength(20);
    const deferred = await rows(
      `SELECT count(*) AS n FROM mail_queue WHERE lane = 'bulk' AND status = 'deferred'`,
    );
    expect(Number(deferred[0]?.['n'])).toBe(484);
    clock = new Date('2026-10-29T11:00:01.000Z');
    await drainMailOnce({ store, noreply: noreply.mailer, now }, state);
    const sent = await rows(`SELECT count(*) AS n FROM mail_queue WHERE status = 'sent'`);
    expect(Number(sent[0]?.['n'])).toBe(20 + 16 + 36);
  }, 120_000);

  it('INT-56-32: security@ refusing → auth via noreply@, degraded raised once', async () => {
    clock = new Date('2026-10-29T12:00:00.000Z');
    await enqueue(3, 'password_reset');
    const noreply = capture();
    const refused = Object.assign(new Error('535'), { code: 'EAUTH', responseCode: 535 });
    const security = { send: vi.fn(() => Promise.reject(refused)) };
    const alert = vi.fn(() => Promise.resolve());
    const state = createMailDrainerState();
    const store = createMailQueueStore(workerDb);
    await drainMailOnce({ store, noreply: noreply.mailer, security, alert, now }, state);
    await drainMailOnce({ store, noreply: noreply.mailer, security, alert, now }, state);
    expect(noreply.sent).toHaveLength(3);
    const via = await rows(`SELECT DISTINCT mailbox FROM mail_queue WHERE status = 'sent'`);
    expect(via.map((r) => r['mailbox'])).toEqual(['noreply']);
    expect(
      alert.mock.calls.filter((c) => (c as unknown[])[0] === 'mail_provider_degraded'),
    ).toHaveLength(1);
  });

  it('REL-13: an abandoned claim is not resent, then sent exactly once', async () => {
    clock = new Date('2026-10-29T13:00:00.000Z');
    await enqueue(1, 'invitation');
    const store = createMailQueueStore(workerDb);
    await store.claim('transactional', 50, '00000000-0000-0000-0000-00000000dead', clock);
    const noreply = capture();
    const state = createMailDrainerState();
    await drainMailOnce({ store, noreply: noreply.mailer, now }, state);
    expect(noreply.sent).toHaveLength(0);
    clock = new Date('2026-10-29T13:11:00.000Z');
    await drainMailOnce({ store, noreply: noreply.mailer, now }, state);
    await drainMailOnce({ store, noreply: noreply.mailer, now }, state);
    expect(noreply.sent).toHaveLength(1);
  });
});
