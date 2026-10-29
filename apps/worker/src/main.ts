import { loadEnv } from '@tmanage/config';
import type { Env } from '@tmanage/config';
import { ConsoleMailer, SmtpMailer } from '@tmanage/mail';
import type { Mailer } from '@tmanage/mail';
import { createWorkerDatabase, workerConnectionLimit } from './common/database/worker-database.js';
import type { WorkerMode } from './common/database/worker-database.js';
import { selectWorkerCommand, unparkDiagnosticLines, workerModeFor } from './cli.js';
import { readOutboxBacklog, unparkEvents } from './common/database/outbox-store.js';
import {
  CREDENTIAL_NOTICE_QUEUE,
  readNoticeBacklog,
  unparkNotices,
} from './common/database/notice-store.js';
import { runOutboxBatch, runOutboxLoop, runQueueBatch, runQueueLoop } from './outbox/dispatcher.js';
import type { BatchReport } from './outbox/dispatcher.js';
import {
  backlogIsStale,
  describeHealth,
  evaluateOutboxHealth,
  mergeBacklogs,
  onceIsUnhealthy,
  readHeartbeatState,
  writeHeartbeat,
} from './outbox/health.js';
import type { OutboxHealthThresholds } from './outbox/health.js';
import {
  both,
  createWorkerNoticeHandlers,
  createWorkerOutboxHandlers,
} from './consumers/registry.js';
import { ClientRequestMailer } from './notifications/client-request-mailer.js';
import { CredentialChangeMailer } from './notifications/credential-change-mailer.js';
import { UsageThresholdMailer } from './notifications/usage-threshold-mailer.js';
import { CollaborationMailer } from './notifications/collaboration-mailer.js';
import { PrivacyMailer } from './notifications/privacy-mailer.js';
import { createRealtimeServer } from './realtime/server.js';
import { createDirectMessageFanOut, createMessageFanOut } from './realtime/fan-out.js';
import { createInvitationSweepStore } from './common/database/invitations-sweep-store.js';
import { sweepOverdueInvitations } from './invitations/invitation-sweep.js';
import { createRequestDeferSweepStore } from './common/database/request-defer-store.js';
import { sweepDeferredRequests } from './jobs/request-defer-sweeper.js';
import { createDueSoonSweepStore } from './common/database/due-soon-store.js';
import { sweepDueSoon } from './jobs/due-soon-sweeper.js';
// ---- platform-admin v2 · PA-03 ---- the content purge.
import { PURGE_HOOKS, runPurge } from './jobs/purge-sweeper.js';
// ---- platform-admin v2 · PA-05 ---- the Support-session expiry sweep.
import {
  runSupportSessionSweep,
  runSupportSessionSweepLoop,
} from './jobs/support-session-sweeper.js';
// ---- platform-admin v2 · PA-07 ---- the organization purge registers itself in PURGE_HOOKS.
import './jobs/purge-organizations.js';

/**
 * The worker process entry point.
 *
 * Three modes, per `50-BOOTSTRAP` §3's deployment reality:
 *
 * - **`--once`** runs a single controlled batch and exits with its report — the shape for
 *   a host that cannot keep a third Node process alive reliably. A scheduler (cron, a
 *   deploy hook, a hand) invokes `pnpm --filter @tmanage/worker relay:once` as often as
 *   delivery latency needs to be short. **It exits 1 when the oldest undelivered event is
 *   older than `OUTBOX_BACKLOG_MAX_AGE_SECONDS`**, so cron's own failure reporting becomes
 *   the alarm the audit found missing (CRITICAL-2). A batch that merely fails an event
 *   still exits 0 — the retry is the design, and a page per transient failure is a page
 *   nobody reads.
 * - **`--status`** delivers nothing and reports: backlog age, parked count, and how long
 *   ago a batch last finished, as one JSON line, exiting 1 when any of those is past its
 *   threshold. The monitoring surface for a host that has no spare port for the worker to
 *   answer on — `pnpm --filter @tmanage/worker relay:status`, from cron or an uptime check.
 * - **`--unpark <event-id>`**, or **`--unpark --all`**, replays parked events: `attempts`
 *   back to zero and due immediately, so the next batch delivers them. It is the way *out* of
 *   parking, which until now was hand-written SQL — and an alarm whose only stand-down is
 *   hand-written SQL is an alarm somebody silences instead (x8 review IMPORTANT-2). It
 *   delivers nothing itself and names every row it replayed on stderr.
 * - **`--sweep-invitations`** (TEN-003 / ON-04) runs the one cross-tenant `pending → expired`
 *   move the API's manual `POST /invitations/expirations` route also runs, prints the count and
 *   exits — the scheduled half of invitation expiry, on the same `relay:once` cron shape. It
 *   delivers nothing from the outbox and leaves the manual route in place as a fallback.
 * - **`--sweep-due-soon`** (C1) runs every enabled "work item due in N days" automation rule
 *   for its open items due within its window, at most once per item per rule per day.
 * - **`--sweep-purge`** (platform-admin v2 · PA-03) removes soft-deleted content whose restore
 *   window (`purge_after`) has passed, in bounded tenant-scoped batches, then runs PURGE_HOOKS.
 * - **No flag** runs the polling loop until SIGINT/SIGTERM, finishing the in-flight batch
 *   before leaving — the standalone-worker shape for a host that supports one.
 *
 * Everything tunable comes from `@tmanage/config` — the worker owns no `process.env`
 * reads beyond handing the bag to `loadEnv`, so a malformed variable fails loudly at boot
 * here exactly as it does in the API.
 *
 * `console.warn`/`console.error` are the process's log lines for now; OBS-001 is the
 * structured-logging ticket, and inventing half of it here would be scope this file does
 * not have. The report never contains payloads — see `BatchReport`.
 */

function describe(report: BatchReport): string {
  const parked = report.parked.length > 0 ? `, ${report.parked.length} parked` : '';
  // Effects are counted, never described: an effect failure's message is the driver's own
  // words and may name a recipient's address. The producer logs those itself, to the
  // operator's log and nowhere else.
  const effects =
    report.effects > 0
      ? `, ${report.effects} after-commit effect(s)` +
        (report.effectFailures.length > 0 ? ` of which ${report.effectFailures.length} failed` : '')
      : '';
  // Backlog age on every line, not only when something was claimed: the whole point of
  // CRITICAL-2 is that "nothing was claimed" and "nothing is running" must stop looking alike.
  const oldest = report.backlog.oldestPendingSeconds;
  const backlog =
    `, backlog ${report.backlog.pending} pending` + (oldest === null ? '' : `, oldest ${oldest}s`);
  return (
    `claimed ${report.claimed}, published ${report.published} ` +
    `(${report.unhandled} with no consumer), failed ${report.failed}${parked}${effects}${backlog}`
  );
}

/**
 * The relay's mail transport, chosen the way `MailerModule.forConfig` chooses the API's.
 *
 * `loadEnv` has already parsed and cross-validated every `EMAIL_*` and `SMTP_*` key — it is
 * one schema for the whole monorepo — so there is nothing to re-check here beyond the
 * narrowing TypeScript needs. `packages/config` refuses `EMAIL_DRIVER=smtp` without
 * `SMTP_HOST` at boot, which is why the fallback below is a type guard and not a policy.
 */
function mailerFrom(env: Env): Mailer | null {
  const from = { fromAddress: env.EMAIL_FROM_ADDRESS, fromName: env.EMAIL_FROM_NAME };
  if (env.EMAIL_DRIVER === 'console') return new ConsoleMailer(from);
  if (env.SMTP_HOST === undefined || env.SMTP_HOST === '') return null;
  return new SmtpMailer({
    ...from,
    host: env.SMTP_HOST,
    port: env.SMTP_PORT,
    secure: env.SMTP_SECURE,
    username: env.SMTP_USERNAME,
    password: env.SMTP_PASSWORD,
  });
}

/**
 * Record that a batch finished, if a path was configured.
 *
 * Failure to write is logged and swallowed on purpose: the relay's job is delivery, and a
 * heartbeat it could not write goes stale on its own — which a monitor reads as unhealthy,
 * correctly, since a worker whose disk refuses writes is not well.
 */
async function beat(path: string | undefined, at: Date): Promise<void> {
  if (path === undefined) return;
  try {
    await writeHeartbeat(path, at);
  } catch (error) {
    console.error('[worker] could not write heartbeat', error);
  }
}

async function main(): Promise<void> {
  const env = loadEnv();
  // Argument parsing and mode selection are `cli.ts`'s pure functions so they can be tested
  // without a database (x8 review IMPORTANT-G). `--unpark` wins over `--status` wins over
  // `--once`; `--once --status` therefore reports and delivers nothing. See `selectWorkerCommand`.
  const command = selectWorkerCommand(process.argv);
  const thresholds: OutboxHealthThresholds = {
    backlogMaxAgeSeconds: env.OUTBOX_BACKLOG_MAX_AGE_SECONDS,
    heartbeatMaxAgeSeconds: env.OUTBOX_HEARTBEAT_MAX_AGE_SECONDS,
  };
  // Every flagged mode delivers from a single sequential pass and exits; only the no-flag
  // shape holds two loops and the realtime server open at once, and only it needs the third
  // connection. See `workerConnectionLimit`.
  const mode: WorkerMode = workerModeFor(command);

  // The relay's own least-privilege credential when it is set; the API's otherwise, named
  // on stderr so nobody reads a development fallback as the production shape.
  console.warn(
    `[worker] database credential: ${env.WORKER_DATABASE_URL ? 'WORKER_DATABASE_URL' : 'DATABASE_URL (WORKER_DATABASE_URL not set)'}`,
  );
  const database = createWorkerDatabase({
    url: env.WORKER_DATABASE_URL ?? env.DATABASE_URL,
    connectionLimit: workerConnectionLimit(env.DATABASE_POOL_MAX, mode),
    statementTimeoutMs: env.DATABASE_STATEMENT_TIMEOUT_MS,
    onConnectionError: (error) => {
      console.error('[worker] connection rejected during session setup', error);
    },
  });

  // Replay and leave: no handlers are built and nothing is delivered here — the rows are made
  // claimable again and the next batch, loop or cron, does the delivering.
  //
  // Tenant safety: there is no organization selector, by construction. `unparkEvents` takes a
  // primary key or nothing at all, the relay is org-blind throughout (delivery order is global
  // across every tenant), and the process runs as `tmanage_worker`, a system role rather than
  // any tenant's. So there is no tenant to pass wrongly — the worst a typo does is name an id
  // that is not parked, which the predicate refuses and the exit code reports. The one broad
  // form, `--all`, has to be asked for by name: a bare `--unpark` refuses rather than guessing.
  if (command.kind === 'unpark' || command.kind === 'unpark-invalid') {
    try {
      if (command.kind === 'unpark-invalid') {
        console.error(
          '[worker] relay:unpark needs exactly one of: an event id, or --all for every parked event',
        );
        process.exitCode = 2;
        return;
      }
      // Both queues — x31. A parked notice is the same operator condition as a parked event
      // and must have the same way out; an id is a primary key in exactly one of the two
      // tables, so naming one and finding it in the other is not a case that can arise.
      const selector = command.selector;
      const replayed = await database.transaction(async (tx) => [
        ...(await unparkEvents(tx, env.OUTBOX_MAX_ATTEMPTS, selector)),
        ...(await unparkNotices(tx, env.OUTBOX_MAX_ATTEMPTS, selector)),
      ]);
      // Carry-over 2: `--all` clears `last_error` on every parked row at once, and nothing else
      // — not `relay:status`, not the per-row confirmation below — ever prints it, so this is
      // the last chance to read the diagnosis before it is gone. The value was captured by the
      // `FOR UPDATE` select before the reset landed, so it is the pre-reset error even though it
      // prints after. Only `--all` does this; a named id leaves the rest of the parked set and
      // its diagnoses readable, so its output is unchanged. `last_error` can quote a recipient,
      // but the operator running `--all` already holds the worker credential and the diagnosis
      // is about to be destroyed for good — surfacing it to that same operator's log is the
      // smaller loss.
      for (const line of unparkDiagnosticLines(replayed, selector)) {
        console.warn(line);
      }
      // Named one per line, organization included: this is an operator overriding the relay's
      // own verdict, and it is the only record that it happened. No payload — a driver message
      // can quote a recipient, and the payload is never the operator's to read here.
      for (const event of replayed) {
        console.warn(
          `[worker] unparked ${event.id} (${event.type}, organization ` +
            `${event.organizationId ?? 'none — not tenant-owned'}) ` +
            `after ${String(event.attempts)} attempts — due now`,
        );
      }
      console.warn(`[worker] relay:unpark replayed ${String(replayed.length)} parked row(s)`);
      // A named id that matched nothing was not replayed, and the operator must hear that from
      // the exit code, not only from a count. `--all` finding nothing parked is a no-op success.
      if (replayed.length === 0 && selector !== null) {
        console.error('[worker] no parked event with that id — nothing was changed');
        process.exitCode = 1;
      }
    } finally {
      await database.end();
    }
    return;
  }

  // Report and leave: no handlers are built, nothing is claimed, and the only statement is
  // the aggregate read. Safe to run from cron beside a live loop, and safe to run on a
  // schedule of its own on a host where the relay is cron-driven batches.
  if (command.kind === 'status') {
    try {
      // Both queues, one verdict (x31) — see `mergeBacklogs`. The JSON line keeps every key
      // a monitor already parses, with the same summed meaning, and gains a `queues` object
      // carrying the same three numbers per queue.
      const outboxBacklog = await database.read((tx) =>
        readOutboxBacklog(tx, env.OUTBOX_MAX_ATTEMPTS),
      );
      const noticeBacklog = await database.read((tx) =>
        readNoticeBacklog(tx, env.OUTBOX_MAX_ATTEMPTS),
      );
      const backlog = mergeBacklogs(outboxBacklog, noticeBacklog);
      const queues = { outbox: outboxBacklog, notices: noticeBacklog };
      // CRITICAL-A: "no heartbeat file configured" must not read as "heartbeat missing". A host
      // with no writable path keeps none, and its absence is honest, not degraded.
      const { configured, lastPollAt } = await readHeartbeatState(env.OUTBOX_HEARTBEAT_FILE);
      const health = evaluateOutboxHealth({
        backlog,
        // The per-queue split, in the JSON line rather than only on stderr: a summed
        // `parked: 1` does not say which table is stuck, and a monitor cannot read the
        // operator's stream to find out.
        queues,
        heartbeatConfigured: configured,
        lastPollAt,
        now: new Date(),
        thresholds,
      });
      // One JSON line on stdout for a machine, one sentence on stderr for a person. Written
      // directly rather than through `console` because stdout here is a data channel — a
      // caller pipes it to `jq` — and the workspace's `no-console` rule reserves `console`
      // for the operator's log, which is stderr. The exit code is the contract: 0 draining,
      // 1 not. Nothing in the line names an organization, a recipient or a payload.
      process.stdout.write(`${JSON.stringify(health)}\n`);
      console.warn(`[worker] queues ${describeHealth(health)}`);
      // The same split the JSON's `queues` carries, in the operator's words. Both queues are
      // named rather than only the notices: "of which notices" made the reader subtract.
      console.warn(
        `[worker] of which outbox: pending ${String(outboxBacklog.pending)}, ` +
          `parked ${String(outboxBacklog.parked)}; notices: pending ` +
          `${String(noticeBacklog.pending)}, parked ${String(noticeBacklog.parked)}`,
      );
      if (health.status !== 'ok') process.exitCode = 1;
    } finally {
      await database.end();
    }
    return;
  }

  // TEN-003 / ON-04: the invitation-expiry sweep. Delivers nothing from the outbox and builds no
  // handlers — its whole job is the one cross-tenant `pending → expired` move the API's manual
  // route (`POST /invitations/expirations`) also runs, on the `relay:once` shape a host cron
  // already invokes. The count goes to stdout as a data line (a caller may read it), the operator
  // sentence to stderr, and the process exits 0; a store failure rejects and `main().catch` turns
  // it into exit 1 — non-zero only on failure, so sweeping nothing is a success (idempotent).
  if (command.kind === 'sweep-invitations') {
    try {
      const result = await sweepOverdueInvitations(createInvitationSweepStore(database));
      process.stdout.write(`${JSON.stringify({ expired: result.expired })}\n`);
      console.warn(
        `[worker] invitation sweep: expired ${String(result.expired)} overdue invitation(s)`,
      );
    } finally {
      await database.end();
    }
    return;
  }

  // A7 (0220): the deferred-request sweep — due `deferred` requests back to `triage`, with an
  // in-app reminder for a deferrer who asked for one. Same shape and exit contract as above.
  if (command.kind === 'sweep-deferred-requests') {
    try {
      const result = await sweepDeferredRequests(createRequestDeferSweepStore(database));
      process.stdout.write(`${JSON.stringify(result)}\n`);
      console.warn(
        `[worker] defer sweep: reopened ${String(result.reopened)} deferred request(s), ` +
          `reminded ${String(result.reminded)}`,
      );
    } finally {
      await database.end();
    }
    return;
  }

  // C1: the "work item due in N days" automation sweep — every enabled due-soon rule runs for
  // its open items due within its window, at most once per item per day. Same exit contract.
  if (command.kind === 'sweep-due-soon') {
    try {
      const result = await sweepDueSoon(createDueSoonSweepStore(database));
      process.stdout.write(`${JSON.stringify(result)}\n`);
      console.warn(
        `[worker] due-soon sweep: ${String(result.rules)} rule(s), ` +
          `fired for ${String(result.fired)} work item(s), ` +
          `delivered ${String(result.delivered)} weekend-held run(s)`,
      );
    } finally {
      await database.end();
    }
    return;
  }

  // ---- platform-admin v2 · PA-03 ---- the content purge: rows past purge_after, hourly cron.
  if (command.kind === 'sweep-purge') {
    try {
      const result = await runPurge(database, PURGE_HOOKS);
      process.stdout.write(`${JSON.stringify(result)}\n`);
      console.warn(
        `[worker] content purge: deleted ${String(result.deleted)} row(s), ` +
          `${String(result.blocked)} still referenced`,
      );
    } finally {
      await database.end();
    }
    return;
  }

  // ---- platform-admin v2 · PA-05 ---- expired Support sessions: end, offboard/restore, bump.
  if (command.kind === 'sweep-support-sessions') {
    try {
      const result = await runSupportSessionSweep(database);
      process.stdout.write(`${JSON.stringify(result)}\n`);
      console.warn(
        `[worker] support sessions: ended ${String(result.ended)} expired session(s), ` +
          `offboarded ${String(result.offboarded)}, restored ${String(result.restored)}`,
      );
    } finally {
      await database.end();
    }
    return;
  }

  // The relay's own producer. The console driver counts as a transport — printing the
  // composed message is its whole job, and the bootstrap profile is where a developer reads
  // what a client would have received.
  // One transport, two registries. `mailerFrom` is called once: two drivers would mean two
  // SMTP connection pools for one process, and the console driver would print each message
  // under a different banner.
  const transport = mailerFrom(env);
  const handlers = createWorkerOutboxHandlers({
    clientRequestMailer: new ClientRequestMailer(transport, env.WEB_PUBLIC_URL),
    // USAGE-001 slice 4c — the storage-threshold mail. No link, so no WEB_PUBLIC_URL: the usage
    // screen it would point at is a later slice and does not exist yet.
    usageThresholdMailer: new UsageThresholdMailer(transport),
    // CQ-12 — mentions, comments, meeting invites, project adds and client-action emails.
    collaborationMailer: new CollaborationMailer(transport, env.WEB_PUBLIC_URL),
    // H3 — data export ready, deletion scheduled / cancelled / carried out.
    privacyMailer: new PrivacyMailer(transport, env.WEB_PUBLIC_URL),
  });
  // x31: the notice queue's own registry. Empty when no transport is wired, which drains and
  // stamps rather than growing a tail — see `createWorkerNoticeHandlers`.
  const noticeHandlers = createWorkerNoticeHandlers({
    credentialChangeMailer: new CredentialChangeMailer(transport),
  });

  const options = {
    batchSize: env.OUTBOX_BATCH_SIZE,
    maxAttempts: env.OUTBOX_MAX_ATTEMPTS,
    backoffBaseMs: env.OUTBOX_BACKOFF_BASE_MS,
    backoffCapMs: env.OUTBOX_BACKOFF_CAP_MS,
  };

  if (command.kind === 'once') {
    try {
      const report = await runOutboxBatch(database, handlers, options);
      // x31: the second queue, drained in the same invocation. Sequential, not parallel —
      // the pool is capped at two connections and a controlled batch has no reason to race
      // itself for them. The heartbeat is written once both have run, so a beat still means
      // "the relay completed a pass", not "one of its queues did".
      const noticeReport = await runQueueBatch(
        database,
        CREDENTIAL_NOTICE_QUEUE,
        noticeHandlers,
        options,
      );
      await beat(env.OUTBOX_HEARTBEAT_FILE, new Date());
      console.warn(`[worker] batch: ${describe(report)}`);
      console.warn(`[worker] notice batch: ${describe(noticeReport)}`);
      for (const parked of [...report.parked, ...noticeReport.parked]) {
        console.error(
          `[worker] parked row ${parked.id} (${parked.type}) after ${parked.attempts} attempts`,
        );
      }
      // The alarm, in the one place a cron-driven deployment can hear it. Two conditions, both
      // things an operator must know about and neither of which a batch deployment can surface
      // any other way: the backlog is older than the threshold (the relay is not draining,
      // whatever the cause), or at least one event has parked (CRITICAL-C — permanent, silent
      // non-delivery until someone resets its attempts). An event that merely *failed* this
      // batch is due to be retried and is not yet a problem, so it is deliberately not here.
      const backlog = mergeBacklogs(report.backlog, noticeReport.backlog);
      if (backlogIsStale(backlog, thresholds.backlogMaxAgeSeconds)) {
        console.error(
          `[worker] relay backlog is ${String(backlog.oldestPendingSeconds)}s old, ` +
            `over the ${String(thresholds.backlogMaxAgeSeconds)}s threshold — the relay is not draining`,
        );
      }
      if (onceIsUnhealthy(backlog, thresholds.backlogMaxAgeSeconds)) {
        process.exitCode = 1;
      }
    } finally {
      await database.end();
    }
    return;
  }

  const controller = new AbortController();
  const stop = (): void => controller.abort();
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);

  // ---- platform-admin v2 · PA-05 ---- the Support-session sweep, every minute beside the
  // relay. It borrows a pool connection only while it runs, logs its own failures and stops with
  // the same signal.
  const supportSweep = runSupportSessionSweepLoop(database, controller.signal);

  // RT-001. Sockets exist only in loop mode — a controlled batch has no process to keep a
  // socket open — and only when a port is configured; 0 is the honest default on a host
  // that cannot keep this process alive. The fan-out handler joins the registry only when
  // a hub actually exists, so batch deployments never claim events for nobody.
  const realtime =
    env.REALTIME_PORT > 0
      ? await createRealtimeServer({
          database,
          sessionSecret: env.SESSION_SECRET,
          port: env.REALTIME_PORT,
        })
      : undefined;
  if (realtime) console.warn(`[worker] realtime socket listening on :${realtime.port}`);

  // CQ-12: the mention notices and the fan-out both answer `message.created.v1`, so the two
  // are composed rather than the fan-out replacing the registry's handler.
  const mentions = handlers['message.created.v1'];
  const fanOut = realtime ? createMessageFanOut(realtime.hub) : undefined;
  // BK3-left: the same composition for direct messages — recipient notice, then the frame.
  const directNotices = handlers['direct_message.created.v1'];
  const directFanOut = realtime ? createDirectMessageFanOut(realtime.hub) : undefined;
  const loopHandlers =
    fanOut === undefined || directFanOut === undefined
      ? handlers
      : {
          ...handlers,
          'message.created.v1': mentions === undefined ? fanOut : both(mentions, fanOut),
          'direct_message.created.v1':
            directNotices === undefined ? directFanOut : both(directNotices, directFanOut),
        };

  // x31. Two loops, one process, one `AbortSignal`: the notice queue drains beside the outbox
  // rather than behind it, so a backlog of events cannot delay a security receipt and a notice
  // handler cannot stall the relay. `Promise.all` keeps the shape the single loop had — either
  // loop leaves only by abort or by throwing, and a throw from either ends the process.
  try {
    await Promise.all([
      runOutboxLoop(database, loopHandlers, {
        ...options,
        pollIntervalMs: env.OUTBOX_POLL_INTERVAL_MS,
        signal: controller.signal,
        onBatch: (report) => {
          // The heartbeat is the loop's half of CRITICAL-2: a batch that completed is the
          // only evidence this process is alive, and it must be recorded whether or not the
          // batch had anything to do. Fire-and-forget — `beat` swallows its own failures and
          // the loop must not wait on a disk to keep delivering.
          void beat(env.OUTBOX_HEARTBEAT_FILE, new Date());
          if (report.claimed > 0 || report.parked.length > 0) {
            console.warn(`[worker] batch: ${describe(report)}`);
          } else if (backlogIsStale(report.backlog, thresholds.backlogMaxAgeSeconds)) {
            // Claimed nothing, yet something has been waiting past the threshold: rows exist
            // that this relay cannot take — parked, or locked by another process that is not
            // draining them. Silence here is what the audit found; this is the line.
            console.error(`[worker] outbox not draining: ${describe(report)}`);
          }
        },
        onError: (error) => {
          console.error('[worker] batch failed whole', error);
        },
      }),
      // The notice queue. Its own `consecutiveErrors`, its own poll, its own log prefix — the
      // two queues share a process and a signal and nothing else.
      runQueueLoop(database, CREDENTIAL_NOTICE_QUEUE, noticeHandlers, {
        ...options,
        pollIntervalMs: env.OUTBOX_POLL_INTERVAL_MS,
        signal: controller.signal,
        onBatch: (report) => {
          // Beaten by both loops: the heartbeat records that *this process* completed a pass,
          // and either loop completing one is evidence of that.
          void beat(env.OUTBOX_HEARTBEAT_FILE, new Date());
          if (report.claimed > 0 || report.parked.length > 0) {
            console.warn(`[worker] notice batch: ${describe(report)}`);
          } else if (backlogIsStale(report.backlog, thresholds.backlogMaxAgeSeconds)) {
            console.error(`[worker] notices not draining: ${describe(report)}`);
          }
        },
        onError: (error) => {
          console.error('[worker] notice batch failed whole', error);
        },
      }),
    ]);
  } finally {
    await realtime?.close();
    // ---- platform-admin v2 · PA-05 ---- let the sweep finish its pass before the pool closes.
    controller.abort();
    await supportSweep;
    await database.end();
  }
}

main().catch((error: unknown) => {
  console.error('[worker] fatal', error);
  process.exitCode = 1;
});
