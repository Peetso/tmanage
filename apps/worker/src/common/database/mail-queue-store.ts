import type { MailLane, Mailbox, MailQueueEntry, MailQueueWriter } from '@tmanage/mail';
import type { WorkerDatabase, WorkerTransaction } from './worker-database.js';

/**
 * 56-31 — every statement the mail drainer issues against `mail_queue`, `mail_hour_windows` and
 * `platform_settings` (0256). Grants (users.sql): SELECT/INSERT/UPDATE/DELETE on `mail_queue`,
 * SELECT/INSERT/UPDATE on `mail_hour_windows`, SELECT on `platform_settings`.
 *
 * ## The claim is two steps (REL-13)
 *
 * `UPDATE … SET status = 'sending', claim_token = ? WHERE status = 'queued' … ORDER BY
 * available_at, id LIMIT ?` takes rows atomically — two drainers can never set the same row's
 * token, because the second UPDATE no longer sees it `queued` — and `SELECT … WHERE claim_token
 * = ?` reads back exactly the rows this tick owns. A drainer killed between claim and send leaves
 * its rows `sending`; `recoverStale` re-queues such a row once, ten minutes later, so a crash
 * delays a message and never sends it twice within a claim. On claim `available_at` is set to the
 * claim instant, which is what the stale check measures.
 */

export interface ClaimedMail {
  readonly id: string;
  /** 56-26: the sending company, handed back to the SMTP driver to sign the Message-ID. */
  readonly organizationId: string | null;
  readonly lane: MailLane;
  readonly mailbox: Mailbox;
  readonly templateKey: string;
  readonly payloadJson: string;
  readonly attempts: number;
  readonly deadlineAt: Date | null;
}

export interface DeferredCounts {
  readonly auth: number;
  readonly transactional: number;
}

export interface MailQueueStore extends MailQueueWriter {
  recoverStale(now: Date, staleBefore: Date): Promise<number>;
  requeueDue(now: Date): Promise<number>;
  settings(keys: readonly string[]): Promise<Map<string, string>>;
  windowCounts(windowStart: Date): Promise<Map<Mailbox, number>>;
  claim(lane: MailLane, limit: number, token: string, now: Date): Promise<ClaimedMail[]>;
  deferQueued(lane: MailLane, now: Date, until: Date): Promise<number>;
  countWindow(mailbox: Mailbox, windowStart: Date): Promise<void>;
  markSent(
    id: string,
    token: string,
    mailbox: Mailbox,
    at: Date,
    messageId: string | null,
  ): Promise<void>;
  markFailed(id: string, token: string, error: string): Promise<void>;
  markSuppressed(id: string, token: string): Promise<void>;
  retryLater(id: string, token: string, at: Date): Promise<void>;
  deferredCounts(): Promise<DeferredCounts>;
  purge(now: Date): Promise<void>;
}

type Rows = readonly Record<string, unknown>[];

const SQL = {
  insert: `insert into mail_queue
    (id, organization_id, lane, mailbox, to_hash, template_key, payload_json, status, attempts,
     available_at, deadline_at, created_at)
    values (?, ?, ?, ?, ?, ?, ?, 'queued', 0, ?, ?, ?)`,
  staleRequeue: `update mail_queue set status = 'queued', claim_token = null, available_at = ?
    where status = 'sending' and available_at < ? and attempts <= 1`,
  staleFail: `update mail_queue set status = 'failed', claim_token = null, error = 'stale'
    where status = 'sending' and available_at < ? and attempts > 1`,
  requeueDue: `update mail_queue set status = 'queued'
    where status = 'deferred' and available_at <= ?`,
  settings: (n: number) => `select setting_key, setting_value from platform_settings
    where setting_key in (${Array.from({ length: n }, () => '?').join(', ')})`,
  windows: `select mailbox, count as n from mail_hour_windows where window_start = ?`,
  claim: `update mail_queue set status = 'sending', claim_token = ?, attempts = attempts + 1,
      available_at = ?
    where status = 'queued' and lane = ? and available_at <= ?
    order by available_at, id limit ?`,
  claimed: `select id, organization_id, lane, mailbox, template_key, payload_json, attempts, deadline_at
    from mail_queue where claim_token = ? and lane = ? and status = 'sending'
    order by available_at, id`,
  defer: `update mail_queue set status = 'deferred', available_at = ?
    where status = 'queued' and lane = ? and available_at <= ?`,
  count: `insert into mail_hour_windows (mailbox, window_start, count) values (?, ?, 1)
    on duplicate key update count = count + 1`,
  sent: `update mail_queue set status = 'sent', claim_token = null, mailbox = ?, sent_at = ?,
      provider_message_id = ?, error = null
    where id = ? and claim_token = ?`,
  failed: `update mail_queue set status = 'failed', claim_token = null, error = ?
    where id = ? and claim_token = ?`,
  suppressed: `update mail_queue set status = 'suppressed', claim_token = null
    where id = ? and claim_token = ?`,
  retry: `update mail_queue set status = 'queued', claim_token = null, available_at = ?
    where id = ? and claim_token = ?`,
  deferredCounts: `select lane, count(*) as n from mail_queue
    where status = 'deferred' and lane in ('auth', 'transactional') group by lane`,
  purge: `delete from mail_queue
    where status in ('sent', 'failed', 'suppressed') and created_at < ? limit 500`,
  strip: `update mail_queue set payload_json = '{}'
    where lane = 'auth' and status = 'sent' and sent_at < ? and payload_json <> '{}' limit 500`,
} as const;

function num(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function date(value: unknown): Date | null {
  if (value instanceof Date) return value;
  if (typeof value === 'string' && value !== '') return new Date(value);
  return null;
}

async function exec(database: WorkerDatabase, sql: string, params: readonly unknown[]) {
  return database.transaction((tx: WorkerTransaction) => tx.query(sql, params));
}

function affected(result: unknown): number {
  return num((result as { affectedRows?: unknown } | null)?.affectedRows);
}

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

export function createMailQueueStore(database: WorkerDatabase): MailQueueStore {
  return {
    async enqueue(entry: MailQueueEntry): Promise<void> {
      await exec(database, SQL.insert, [
        entry.id,
        entry.organizationId,
        entry.lane,
        entry.mailbox,
        entry.toHash,
        entry.templateKey,
        entry.payloadJson,
        entry.availableAt,
        entry.deadlineAt,
        entry.createdAt,
      ]);
    },
    async recoverStale(now, staleBefore) {
      const requeued = affected(await exec(database, SQL.staleRequeue, [now, staleBefore]));
      await exec(database, SQL.staleFail, [staleBefore]);
      return requeued;
    },
    async requeueDue(now) {
      return affected(await exec(database, SQL.requeueDue, [now]));
    },
    async settings(keys) {
      const out = new Map<string, string>();
      if (keys.length === 0) return out;
      const rows = await database.read((tx) => tx.query<Rows>(SQL.settings(keys.length), keys));
      for (const row of rows)
        out.set(String(row['setting_key']), String(row['setting_value'] ?? ''));
      return out;
    },
    async windowCounts(windowStart) {
      const out = new Map<Mailbox, number>();
      const rows = await database.read((tx) => tx.query<Rows>(SQL.windows, [windowStart]));
      for (const row of rows) {
        const mailbox = String(row['mailbox']);
        if (mailbox === 'security' || mailbox === 'noreply') out.set(mailbox, num(row['n']));
      }
      return out;
    },
    async claim(lane, limit, token, now) {
      if (limit <= 0) return [];
      const rows = await database.transaction(async (tx) => {
        await tx.query(SQL.claim, [token, now, lane, now, limit]);
        return tx.query<Rows>(SQL.claimed, [token, lane]);
      });
      return rows.map((row) => ({
        id: String(row['id']),
        organizationId:
          typeof row['organization_id'] === 'string' ? (row['organization_id'] as string) : null,
        lane: String(row['lane']) as MailLane,
        mailbox: String(row['mailbox']) === 'security' ? 'security' : 'noreply',
        templateKey: String(row['template_key']),
        payloadJson: String(row['payload_json'] ?? ''),
        attempts: num(row['attempts']),
        deadlineAt: date(row['deadline_at']),
      }));
    },
    async deferQueued(lane, now, until) {
      return affected(await exec(database, SQL.defer, [until, lane, now]));
    },
    async countWindow(mailbox, windowStart) {
      await exec(database, SQL.count, [mailbox, windowStart]);
    },
    async markSent(id, token, mailbox, at, messageId) {
      await exec(database, SQL.sent, [mailbox, at, messageId, id, token]);
    },
    async markFailed(id, token, error) {
      await exec(database, SQL.failed, [error.slice(0, 255), id, token]);
    },
    async markSuppressed(id, token) {
      await exec(database, SQL.suppressed, [id, token]);
    },
    async retryLater(id, token, at) {
      await exec(database, SQL.retry, [at, id, token]);
    },
    async deferredCounts() {
      const rows = await database.read((tx) => tx.query<Rows>(SQL.deferredCounts, []));
      let auth = 0;
      let transactional = 0;
      for (const row of rows) {
        if (row['lane'] === 'auth') auth = num(row['n']);
        if (row['lane'] === 'transactional') transactional = num(row['n']);
      }
      return { auth, transactional };
    },
    async purge(now) {
      await exec(database, SQL.purge, [new Date(now.getTime() - 7 * DAY_MS)]);
      await exec(database, SQL.strip, [new Date(now.getTime() - HOUR_MS)]);
    },
  };
}
