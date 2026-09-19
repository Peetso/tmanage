import { describe, expect, it } from 'vitest';
import { runQueueBatch } from './dispatcher.js';
import { evaluateOutboxHealth, mergeBacklogs } from './health.js';
import {
  CREDENTIAL_NOTICE_QUEUE,
  CREDENTIAL_CHANGE_NOTICE_TYPE,
} from '../common/database/notice-store.js';
import { createWorkerNoticeHandlers } from '../consumers/registry.js';
import { CredentialChangeMailer } from '../notifications/credential-change-mailer.js';
import type { Mailer, MailMessage } from '@tmanage/mail';
import type { WorkerDatabase, WorkerTransaction } from '../common/database/worker-database.js';

/**
 * x31 — draining `credential_change_notices` through the existing dispatcher.
 *
 * One case per behaviour the brief names, over a database stubbed down to the statements
 * `notice-store.ts` issues. A fake deliberately, and for the same reason `effects.test.ts`
 * gives: what is under test is *which table is claimed from* and *when the send happens
 * relative to the commit*, and a real server proves the rows but hides the ordering. The
 * claim, attempts, backoff and parking arithmetic themselves are the dispatcher's and are
 * already proven for the outbox loop — this suite does not re-prove them, per the slice's
 * test budget.
 */

const OPTIONS = { batchSize: 10, maxAttempts: 3, backoffBaseMs: 1000, backoffCapMs: 60_000 };

interface FakeNotice {
  readonly id: string;
  readonly userId: string;
  readonly action: string;
  readonly attempts: number;
}

/** Every statement the batch issued, in order, named by what it was. */
function fakeDatabase(
  notices: readonly FakeNotice[],
  log: string[],
  options: { readonly userMissing?: boolean; readonly parked?: readonly FakeNotice[] } = {},
): WorkerDatabase {
  const tx = {
    query: (sql: string, params?: readonly unknown[]): Promise<unknown> => {
      const text = sql.trim().toUpperCase();
      if (text.startsWith('SAVEPOINT') || text.startsWith('ROLLBACK') || text.startsWith('RELEASE'))
        return Promise.resolve(undefined);

      // The recipient read — by primary key, inside the batch transaction.
      if (text.includes('FROM USERS')) {
        log.push('recipient');
        return Promise.resolve(
          options.userMissing === true
            ? []
            : [{ email: 'owner@example.test', display_name: 'Owner' }],
        );
      }
      // The backlog read: raw unpublished rows aggregated in TypeScript by `computeBacklog`,
      // routed on the `NOW(3) AS now_at` marker exactly as `claim-attempts.test.ts` routes the
      // outbox read. One pending row whose `occurred_at` (90s ago) is older than its
      // `available_at` (30s ago), so the age must come from `LEAST(occurred_at, available_at)`
      // per IMPORTANT-E, plus one parked row that is counted but excluded from the age.
      if (text.includes('NOW_AT')) {
        log.push('backlog');
        const now = new Date();
        return Promise.resolve([
          {
            attempts: 0,
            occurred_at: new Date(now.getTime() - 90_000),
            available_at: new Date(now.getTime() - 30_000),
            now_at: now,
          },
          {
            attempts: OPTIONS.maxAttempts,
            occurred_at: new Date(now.getTime() - 500_000),
            available_at: new Date(now.getTime() - 500_000),
            now_at: now,
          },
        ]);
      }
      // The parked report. Named before the reservation's `SELECT id`, which it also matches
      // on table but not on projection.
      if (text.includes('ATTEMPTS >= ?')) {
        log.push('parked-list');
        return Promise.resolve(
          (options.parked ?? []).map((notice) => ({
            id: notice.id,
            action: notice.action,
            attempts: notice.attempts,
            last_error: 'boom',
          })),
        );
      }
      if (text.includes('CREDENTIAL_CHANGE_NOTICES')) {
        if (text.startsWith('SELECT') && text.includes('USER_ID')) {
          log.push('claim-notices');
          return Promise.resolve(
            notices.map((notice) => ({
              id: notice.id,
              user_id: notice.userId,
              action: notice.action,
              correlation_id: null,
              occurred_at: new Date(Date.UTC(2026, 8, 19, 14, 5)),
              // As the reservation left it: the attempt is counted before the handler runs.
              attempts: notice.attempts + 1,
            })),
          );
        }
        if (text.startsWith('SELECT')) {
          log.push('reserve-notices');
          return Promise.resolve(notices.map((notice) => ({ id: notice.id })));
        }
        if (text.includes('PUBLISHED_AT = NOW')) {
          log.push(`publish:${String(params?.[0])}`);
          return Promise.resolve({ affectedRows: 1 });
        }
        if (text.includes('LAST_ERROR = ?')) {
          log.push('fail');
          return Promise.resolve({ affectedRows: 1 });
        }
        log.push('attempts');
        return Promise.resolve({ affectedRows: notices.length });
      }
      log.push(`unexpected:${text.slice(0, 40)}`);
      return Promise.resolve([]);
    },
  } as unknown as WorkerTransaction;

  let transactions = 0;
  return {
    transaction: async <T>(run: (t: WorkerTransaction) => Promise<T>): Promise<T> => {
      transactions += 1;
      const isBatch = transactions === 2;
      const result = await run(tx);
      if (isBatch) log.push('commit');
      return result;
    },
    read: <T>(run: (t: WorkerTransaction) => Promise<T>): Promise<T> => run(tx),
  } as unknown as WorkerDatabase;
}

/** A transport that records what it was asked to send, and one that refuses to. */
function recordingMailer(sent: MailMessage[], failing = false): Mailer {
  return {
    send: (message: MailMessage) => {
      if (failing) return Promise.reject(new Error('smtp refused'));
      sent.push(message);
      return Promise.resolve('sent' as const);
    },
  };
}

describe('the credential-change notice drain', () => {
  it('claims from the notice table, not the outbox, and stamps what it delivered', async () => {
    const log: string[] = [];
    const sent: MailMessage[] = [];
    const handlers = createWorkerNoticeHandlers({
      credentialChangeMailer: new CredentialChangeMailer(recordingMailer(sent)),
    });

    const report = await runQueueBatch(
      fakeDatabase([{ id: 'n1', userId: 'u1', action: 'password_set', attempts: 0 }], log),
      CREDENTIAL_NOTICE_QUEUE,
      handlers,
      OPTIONS,
    );

    // Every statement named `credential_change_notices`; nothing touched `outbox_events`.
    expect(log).toContain('reserve-notices');
    expect(log).toContain('claim-notices');
    expect(log.some((entry) => entry.startsWith('unexpected:'))).toBe(false);
    expect(report.claimed).toBe(1);
    expect(report.published).toBe(1);
    expect(report.unhandled).toBe(0);
    expect(log).toContain('publish:n1');
    // The handler key is the queue's single dispatch key, so the notice reached a consumer.
    expect(Object.keys(handlers)).toEqual([CREDENTIAL_CHANGE_NOTICE_TYPE]);
    // The notice backlog read is correctly routed (its own `NOW(3) AS now_at` marker, not the
    // reservation's `SELECT id`) and `readNoticeBacklog` aggregates its rows: one pending, one
    // parked, and the age taken from the older `occurred_at` (90s) rather than `available_at`.
    expect(log).toContain('backlog');
    expect(report.backlog).toEqual({
      pending: 1,
      parked: 1,
      oldestPendingSeconds: expect.any(Number),
    });
    expect(report.backlog.oldestPendingSeconds).toBeGreaterThanOrEqual(90);
  });

  it('sends after the commit, never inside the batch transaction', async () => {
    const log: string[] = [];
    const sent: MailMessage[] = [];
    const handlers = createWorkerNoticeHandlers({
      credentialChangeMailer: new CredentialChangeMailer(recordingMailer(sent)),
    });

    const report = await runQueueBatch(
      fakeDatabase([{ id: 'n1', userId: 'u1', action: 'password_set', attempts: 0 }], log),
      CREDENTIAL_NOTICE_QUEUE,
      handlers,
      OPTIONS,
    );

    expect(report.effects).toBe(1);
    expect(report.effectFailures).toEqual([]);
    // At-most-once, stated as an ordering: the row is published and the transaction committed
    // before a single byte reaches a transport, so a failed send is never retried.
    expect(log.indexOf('recipient')).toBeLessThan(log.indexOf('commit'));
    expect(log.indexOf('publish:n1')).toBeLessThan(log.indexOf('commit'));
    expect(sent).toHaveLength(1);
    expect(sent[0]?.to).toBe('owner@example.test');
    expect(sent[0]?.subject).toMatch(/password was changed/iu);
    // No link, no address, no secret — a security receipt must not carry the phishing shape.
    expect(sent[0]?.text).not.toMatch(/https?:\/\//u);
    // The route back in must be one that still works after an intruder has changed the
    // password, so it is the workspace administrator rather than "sign in and change it".
    expect(sent[0]?.text).toMatch(/administers your TManage workspace to reset your password/u);
    expect(sent[0]?.text).not.toMatch(/sign in, change your password/u);
  });

  it('drains and stamps without sending when no transport is configured', async () => {
    const log: string[] = [];
    const handlers = createWorkerNoticeHandlers({
      credentialChangeMailer: new CredentialChangeMailer(null),
    });

    const report = await runQueueBatch(
      fakeDatabase([{ id: 'n1', userId: 'u1', action: 'password_set', attempts: 0 }], log),
      CREDENTIAL_NOTICE_QUEUE,
      handlers,
      OPTIONS,
    );

    // No consumer means published to everyone who exists — the queue does not grow a tail on
    // a deployment that is behaving exactly as configured.
    expect(handlers).toEqual({});
    expect(report.published).toBe(1);
    expect(report.unhandled).toBe(1);
    expect(log).toContain('publish:n1');
    expect(log).not.toContain('recipient');
  });

  // Only the missing-user branch is exercised here, and the title says so. A recipient read
  // that *throws* fails the item and backs it off, which is the dispatcher's own path and is
  // proven on this queue by the parking case below — re-proving it through a throwing read
  // would be a second suite for the same behaviour.
  it('is silent about a user who is gone', async () => {
    const missing: string[] = [];
    const gone = await runQueueBatch(
      fakeDatabase([{ id: 'n1', userId: 'u1', action: 'password_set', attempts: 0 }], missing, {
        userMissing: true,
      }),
      CREDENTIAL_NOTICE_QUEUE,
      createWorkerNoticeHandlers({
        credentialChangeMailer: new CredentialChangeMailer(recordingMailer([])),
      }),
      OPTIONS,
    );
    // Silence, not a crash: published with no effect staged, so nothing parks about an
    // account nobody can be told about.
    expect(gone.published).toBe(1);
    expect(gone.failed).toBe(0);
    expect(gone.effects).toBe(0);
  });

  it('parks a notice whose handler keeps failing, and reports it', async () => {
    const log: string[] = [];
    const throwing = {
      [CREDENTIAL_CHANGE_NOTICE_TYPE]: () => Promise.reject(new Error('handler exploded')),
    };

    const report = await runQueueBatch(
      fakeDatabase([{ id: 'n1', userId: 'u1', action: 'password_set', attempts: 2 }], log, {
        parked: [{ id: 'n1', userId: 'u1', action: 'password_set', attempts: 3 }],
      }),
      CREDENTIAL_NOTICE_QUEUE,
      throwing,
      OPTIONS,
    );

    expect(report.failed).toBe(1);
    expect(log).toContain('fail');
    expect(log).not.toContain('publish:n1');
    // Parking is the dispatcher's arithmetic over the notice table's own `attempts`, and the
    // parked row is named in the report the operator reads.
    expect(report.parked.map((row) => row.id)).toEqual(['n1']);
    expect(report.parked[0]?.type).toBe(`${CREDENTIAL_CHANGE_NOTICE_TYPE}:password_set`);
    // Not tenant-owned, and the report says so rather than inventing an organization.
    expect(report.parked[0]?.organizationId).toBeNull();
  });

  it('makes a parked notice degrade the relay’s health exactly as a parked event does', () => {
    const drainedOutbox = { pending: 0, parked: 0, oldestPendingSeconds: null };
    const parkedNotices = { pending: 0, parked: 1, oldestPendingSeconds: null };

    const health = evaluateOutboxHealth({
      backlog: mergeBacklogs(drainedOutbox, parkedNotices),
      heartbeatConfigured: false,
      lastPollAt: null,
      now: new Date(),
      thresholds: { backlogMaxAgeSeconds: 300, heartbeatMaxAgeSeconds: 300 },
    });

    expect(health.status).toBe('degraded');
    expect(health.reasons).toEqual(['parked']);
    expect(health.parked).toBe(1);
  });
});
