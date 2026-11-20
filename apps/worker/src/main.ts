import { loadEnv } from '@tmanage/config';
import type { Env } from '@tmanage/config';
import {
  BounceGuardMailer,
  ConsoleMailer,
  NotificationMailTransport,
  QueueMailer,
  SendCeilingMailer,
  SenderResolvingMailer,
  SmtpMailer,
  SmtpRefusalMailer,
  createIdentityMailers,
  deriveBounceKey,
  deriveUnsubscribeKey,
  resolveMailboxLogin,
  withTemplateKey,
} from '@tmanage/mail';
import type { Mailer, ReceiptMailer, SmtpMailerOptions } from '@tmanage/mail';
import { CONTACT_EMAILS } from '@tmanage/domain';
// ---- 56-31 ---- the mail priority lanes: the queue store and its drainer.
import { createMailQueueStore } from './common/database/mail-queue-store.js';
import { createMailPeopleDirectory } from './common/database/mail-people-store.js';
import { createApprovalEmailSettler } from './common/database/approval-email-send-store.js';
import { createBounceRefusalRecorder } from './common/database/bounce-refusal-store.js';
import { createBounceSuppressionLookup } from './common/database/bounce-suppression-store.js';
import type { MailQueueStore } from './common/database/mail-queue-store.js';
import { createMailDrainerState, drainMailOnce, runMailDrainLoop } from './jobs/mail-drainer.js';
import type { MailDrainerDeps } from './jobs/mail-drainer.js';
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
import { createWorkFanOut, withWorkFanOut } from './realtime/work-fan-out.js';
import { withLinkPreviews } from './consumers/link-previews.js';
import { createInvitationSweepStore } from './common/database/invitations-sweep-store.js';
import { sweepOverdueInvitations } from './invitations/invitation-sweep.js';
import { createRequestDeferSweepStore } from './common/database/request-defer-store.js';
import { createEmailSuppressionLookup } from './common/database/email-suppression-store.js';
import { sweepDeferredRequests } from './jobs/request-defer-sweeper.js';
import { createDueSoonSweepStore } from './common/database/due-soon-store.js';
import { sweepDueSoon } from './jobs/due-soon-sweeper.js';
import { createGettingStartedNudgeStore } from './common/database/getting-started-nudge-store.js';
import { sweepGettingStartedNudges } from './jobs/getting-started-nudges.js';
import { createStorageRootCheckStore } from './common/database/storage-root-check-store.js';
import { sweepStorageRootCheck } from './jobs/storage-root-check.js';
import { StorageRootMailer } from './notifications/storage-root-mailer.js';
// ---- platform-admin v2 · PA-03 ---- the content purge.
import { PURGE_HOOKS, runPurge } from './jobs/purge-sweeper.js';
// ---- platform-admin v2 · PA-05 ---- the Support-session expiry sweep.
import {
  runSupportSessionSweep,
  runSupportSessionSweepLoop,
} from './jobs/support-session-sweeper.js';
// ---- platform-admin v2 · PA-07 ---- the organization purge registers itself in PURGE_HOOKS.
import './jobs/purge-organizations.js';
// ---- platform-admin v2 · PA-09 ---- the Platform admin CSV export job.
import { exportWriterFor, runExportJobsLoop, runExportJobsOnce } from './jobs/export-jobs.js';
import { createFieldCipher, loadFieldCipherKeyring } from '@tmanage/domain/field-cipher';
import { createRotationStore } from './common/database/field-cipher-rotation-store.js';
import { runKeyRotation } from './jobs/field-cipher-rotation.js';
// ---- R13-s2 ---- outbound webhooks: the delivery sweep (staging rides the registry).
import {
  createWebhookDeliveryStore,
  runWebhookDeliveryPass,
} from './consumers/webhook-deliveries.js';
import { runWebhookRetrySweepLoop } from './jobs/webhook-retry-sweeper.js';
import { createPersonMailStore } from './common/database/person-mail-store.js';
import { createSweepLockDatabase } from './common/database/sweep-lock.js';
import { runPersonMailLoop } from './jobs/person-mail-sweep.js';
// ---- GROWTH-FIX ---- the recurring jobs both hosts run, defined once.
import { createScheduledJobs, runScheduledJobLoop } from './jobs/scheduled-jobs.js';
// ---- 62-A2 / 62-27 ---- the activity projector and the signals sweep (no model call).
import { createActivityProjectorStore } from './common/database/activity-projector-store.js';
import { runActivityProjectorLoop } from './jobs/activity-projector.js';
import { createSignalsStore } from './common/database/signals-store.js';
import { runSignalsSweepLoop } from './jobs/signals-sweeper.js';

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
function smtpOptionsFrom(env: Env, host: string): SmtpMailerOptions {
  return {
    fromAddress: env.EMAIL_FROM_ADDRESS,
    fromName: env.EMAIL_FROM_NAME,
    host,
    port: env.SMTP_PORT,
    secure: env.SMTP_SECURE,
    username: env.SMTP_USERNAME,
    password: env.SMTP_PASSWORD,
    // 56-26: queued company mail gets the signed Message-ID its bounce is matched by.
    bounceKey: deriveBounceKey(env.SESSION_SECRET),
  };
}

function mailerFrom(env: Env): Mailer | null {
  const from = { fromAddress: env.EMAIL_FROM_ADDRESS, fromName: env.EMAIL_FROM_NAME };
  if (env.EMAIL_DRIVER === 'console') return new ConsoleMailer(from);
  if (env.SMTP_HOST === undefined || env.SMTP_HOST === '') return null;
  return new SmtpMailer(smtpOptionsFrom(env, env.SMTP_HOST));
}

/**
 * EMAILBUILD (amendment 3): the noreply driver plus the hello and support mailboxes' own logins,
 * each behind its own send ceiling. The console driver prints everything under one banner.
 */
function sendersFrom(env: Env, driver: Mailer): Mailer | ReceiptMailer {
  if (env.EMAIL_DRIVER !== 'smtp' || env.SMTP_HOST === undefined || env.SMTP_HOST === '') {
    return new SendCeilingMailer(driver);
  }
  return createIdentityMailers({
    base: smtpOptionsFrom(env, env.SMTP_HOST),
    noreply: driver,
    // PERSONMAIL (ADR-0013): each mailbox signs in as its own address; its own *_PASS only
    // overrides the shared SMTP_PASSWORD (owner decision 2026-11-20). A tip leaves from the
    // signing person's own mailbox, signed in as that address with SMTP_PASSWORD.
    hello: {
      username: env.SMTP_HELLO_USER,
      password: env.SMTP_HELLO_PASS,
      address: CONTACT_EMAILS.hello,
    },
    support: {
      username: env.SMTP_SUPPORT_USER,
      password: env.SMTP_SUPPORT_PASS,
      address: CONTACT_EMAILS.support,
    },
  });
}

/**
 * 56-31 — the security@ mailbox (`SMTP_SECURITY_USERNAME` / `SMTP_SECURITY_PASSWORD`, optional
 * `EMAIL_SECURITY_FROM_ADDRESS`) on the same SMTP host. Read from `process.env` rather than the
 * one schema this batch (packages/config is not this slice's file). Absent = one mailbox.
 */
function securityMailerFrom(env: Env): SmtpMailer | null {
  // PERSONMAIL (ADR-0013): its own SMTP_SECURITY_PASSWORD when set, otherwise the shared
  // SMTP_PASSWORD (owner decision 2026-11-20: every mailbox shares one password).
  const login = resolveMailboxLogin(
    {
      username: process.env['SMTP_SECURITY_USERNAME'],
      password: process.env['SMTP_SECURITY_PASSWORD'],
      address: process.env['EMAIL_SECURITY_FROM_ADDRESS'],
    },
    env.SMTP_PASSWORD,
  );
  if (env.SMTP_HOST === undefined || env.SMTP_HOST === '' || login === null) return null;
  const { username, password } = login;
  return new SmtpMailer({
    fromAddress: process.env['EMAIL_SECURITY_FROM_ADDRESS']?.trim() || username,
    fromName: env.EMAIL_FROM_NAME,
    host: env.SMTP_HOST,
    port: env.SMTP_PORT,
    secure: env.SMTP_SECURE,
    username,
    password,
  });
}

/** `MAIL_QUEUE=on` (and an SMTP driver): producers enqueue, the drainer alone submits. */
function mailQueueOn(env: Env): boolean {
  return env.EMAIL_DRIVER === 'smtp' && process.env['MAIL_QUEUE']?.trim().toLowerCase() === 'on';
}

/** The drainer's alert hook: a short ops mail to ALERT_EMAILS, itself queued (transactional). */
function mailAlertsFor(env: Env, queue: Mailer): MailDrainerDeps['alert'] {
  const recipients = (env.ALERT_EMAILS ?? '')
    .split(',')
    .map((address) => address.trim())
    .filter((address) => address.includes('@'));
  if (recipients.length === 0) return undefined;
  return async (kind, facts) => {
    const lines = Object.entries(facts).map(([key, value]) => `${key}: ${String(value)}`);
    const text = [`Mail lane alert: ${kind}`, `Time (UTC): ${new Date().toISOString()}`, ...lines];
    for (const to of recipients) {
      await queue.send({
        to,
        subject: `[TManage alert] mail: ${kind}`,
        text: text.join('\n'),
        templateKey: 'ops_alert',
      });
    }
  };
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

  // 55-24: first-week getting-started nudges — at most one in-app notice per member per day.
  if (command.kind === 'sweep-getting-started') {
    try {
      const result = await sweepGettingStartedNudges(createGettingStartedNudgeStore(database));
      process.stdout.write(`${JSON.stringify(result)}
`);
      console.warn(
        `[worker] getting-started sweep: ${String(result.candidates)} member(s), ` +
          `sent ${String(result.sent)} nudge(s)`,
      );
    } finally {
      await database.end();
    }
    return;
  }

  // 51-17: the weekly storage-root check — owners told at most once a week per connection.
  if (command.kind === 'sweep-storage-root') {
    try {
      const result = await sweepStorageRootCheck(createStorageRootCheckStore(database));
      process.stdout.write(`${JSON.stringify(result)}\n`);
      console.warn(
        `[worker] storage-root check: ${String(result.checked)} connection(s), ` +
          `announced ${String(result.announced)}`,
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

  // ---- 56-02 FieldCipher ---- run queued key rotations to the end, once.
  if (command.kind === 'rotate-keys') {
    try {
      const deps = {
        store: createRotationStore(database),
        cipher: createFieldCipher(loadFieldCipherKeyring(env)),
        log: (line: string) => console.warn(`[worker] ${line}`),
      };
      let result = await runKeyRotation(deps);
      while (result.status !== 'idle') result = await runKeyRotation(deps);
    } finally {
      await database.end();
    }
    return;
  }

  // ---- platform-admin v2 · PA-09 ---- queued CSV exports: write, expire, remove.
  if (command.kind === 'run-exports') {
    try {
      const result = await runExportJobsOnce(database, exportWriterFor(env));
      process.stdout.write(`${JSON.stringify(result)}
`);
      console.warn(
        `[worker] exports: wrote ${String(result.written)}, failed ${String(result.failed)}, ` +
          `removed ${String(result.removed)} file(s)`,
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
  // 51-11: every send passes the host ceiling (§9.2); notification mail additionally goes through
  // the suppression list and carries the signed one-click List-Unsubscribe headers. Privacy and
  // credential notices stay transactional — no unsubscribe, never suppressed.
  const driver = mailerFrom(env);
  // 56-31: with the queue on, every producer enqueues and the drainer below is the only sender;
  // `SendCeilingMailer` stays the drainer's last in-process guard over each SMTP mailbox.
  const queueStore: MailQueueStore | null = mailQueueOn(env)
    ? createMailQueueStore(database)
    : null;
  // MAILREST: a recipient refused at RCPT TO (any identity) is recorded in the company's bounce
  // store, so later company mail to it is held exactly as after a bounce report.
  const refusals = createBounceRefusalRecorder(database);
  const security = securityMailerFrom(env);
  const securityDriver = security === null ? null : new SmtpRefusalMailer(security, refusals);
  const senders =
    driver === null ? null : new SmtpRefusalMailer(sendersFrom(env, driver), refusals);
  const drainer: MailDrainerDeps | null =
    queueStore === null || senders === null
      ? null
      : {
          store: queueStore,
          noreply: senders,
          security: securityDriver === null ? null : new SendCeilingMailer(securityDriver),
          suppressions: createEmailSuppressionLookup(database),
          alert: mailAlertsFor(env, new QueueMailer(queueStore)),
        };
  // 56-26: company mail to an address that bounced in that company is held (auth mail never).
  const transport: Mailer | null =
    senders === null
      ? null
      : new BounceGuardMailer(
          // EMAILBUILD: the sender is chosen from the template key here, above the queue.
          new SenderResolvingMailer(queueStore !== null ? new QueueMailer(queueStore) : senders, {
            identityAddress: env.EMAIL_FROM_ADDRESS,
            sendAs: env.EMAIL_SEND_AS,
            addresses: CONTACT_EMAILS,
            // 0371: tips are signed by the person assigned to the user for the topic.
            directory: createMailPeopleDirectory(database),
            // PERSONMAIL (ADR-0013): every mail carries the one-click unsubscribe headers + footer.
            unsubscribe: {
              url: `${env.API_PUBLIC_URL.replace(/\/+$/u, '')}/v1/public/email/unsubscribe`,
              key: deriveUnsubscribeKey(env.SESSION_SECRET),
            },
          }),
          createBounceSuppressionLookup(database),
        );
  const keyed = (key: string): Mailer | null =>
    transport === null ? null : withTemplateKey(transport, key);
  const notificationTransport =
    transport === null
      ? null
      : new NotificationMailTransport(transport, {
          unsubscribeUrl: `${env.API_PUBLIC_URL.replace(/\/+$/u, '')}/v1/public/email/unsubscribe`,
          key: deriveUnsubscribeKey(env.SESSION_SECRET),
          suppressions: createEmailSuppressionLookup(database),
        });
  // 56-31: each producer's template key, so lanes.ts can put it in its lane.
  const notice = (key: string): Mailer | null =>
    notificationTransport === null ? null : withTemplateKey(notificationTransport, key);
  const handlers = createWorkerOutboxHandlers({
    clientRequestMailer: new ClientRequestMailer(notice('client_request'), env.WEB_PUBLIC_URL),
    // USAGE-001 slice 4c — the storage-threshold mail. No link, so no WEB_PUBLIC_URL: the usage
    // screen it would point at is a later slice and does not exist yet.
    usageThresholdMailer: new UsageThresholdMailer(notice('usage_threshold')),
    // 51-17 — the owners' "company storage at risk" mail.
    storageRootMailer: new StorageRootMailer(notice('storage_root')),
    // CQ-12 — mentions, comments, meeting invites, project adds and client-action emails.
    collaborationMailer: new CollaborationMailer(
      notice('collaboration_notice'),
      env.WEB_PUBLIC_URL,
    ),
    // H3 — data export ready, deletion scheduled / cancelled / carried out.
    privacyMailer: new PrivacyMailer(keyed('privacy_notice'), env.WEB_PUBLIC_URL),
    // QA-FIX-O H1 — the SMTP answer for each approval-request e-mail, for the deliverable page.
    approvalEmailSettler: createApprovalEmailSettler(database),
  });
  // x31: the notice queue's own registry. Empty when no transport is wired, which drains and
  // stamps rather than growing a tail — see `createWorkerNoticeHandlers`.
  const noticeHandlers = createWorkerNoticeHandlers({
    credentialChangeMailer: new CredentialChangeMailer(keyed('credential_change')),
  });

  const options = {
    batchSize: env.OUTBOX_BATCH_SIZE,
    maxAttempts: env.OUTBOX_MAX_ATTEMPTS,
    backoffBaseMs: env.OUTBOX_BACKOFF_BASE_MS,
    backoffCapMs: env.OUTBOX_BACKOFF_CAP_MS,
  };

  if (command.kind === 'once') {
    try {
      // R7 slice 5: link previews ride `message.created.v1`; no hub in a batch, so no frame.
      const report = await runOutboxBatch(database, withLinkPreviews(handlers, database), options);
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
      // 56-31: one drain tick after the batches, so mail they enqueued leaves in this pass.
      if (drainer !== null) await drainMailOnce(drainer, createMailDrainerState());
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
  // ---- EMAILBUILD2 ---- the person-mail sweep, hourly beside the relay: at most 100 members per
  // run, at most one mail each, through the notification transport (List-Unsubscribe, settings
  // link) under template key 'tip', so the sender resolver signs it with the member's person.
  // LOGQUIET-a: the person-mail and webhook passes take the same named locks as the single app's
  // sweeps (`apps/server/scheduled-sweeps.mjs`), so this process and the app never run both.
  const sweepLock = createSweepLockDatabase({ url: env.WORKER_DATABASE_URL ?? env.DATABASE_URL });
  const personMail = runPersonMailLoop(
    {
      store: createPersonMailStore(database),
      mailer: notice('tip'),
      webOrigin: env.WEB_PUBLIC_URL,
      lock: sweepLock,
    },
    controller.signal,
  );
  // ---- 62-A2 ---- the activity projector every minute: audit events filed under their project and
  // client (`activity_entries`), back-filled from the start by cursor. Same `activity-projector`
  // named lock as the single app's sweep, so the two never run at once.
  const activityProjector = runActivityProjectorLoop(
    { store: createActivityProjectorStore(database), lock: sweepLock },
    controller.signal,
  );
  // ---- 62-27 ---- the hourly signals sweep (eight pure rules, only where `business_briefing` is
  // on), under the same `signals-sweeper` lock as the single app's sweep.
  const signalsSweep = runSignalsSweepLoop(
    { store: createSignalsStore(database), lock: sweepLock },
    controller.signal,
  );
  // ---- platform-admin v2 · PA-09 ---- the export job, every 30 seconds beside the relay.
  const exportJobs = runExportJobsLoop(database, exportWriterFor(env), controller.signal);
  // ---- 56-31 ---- the mail drainer, every 5 seconds beside the relay (only with MAIL_QUEUE=on).
  const mailDrain =
    drainer === null ? Promise.resolve() : runMailDrainLoop(drainer, controller.signal);
  // ---- R13-s2 ---- outbound webhooks: due attempts every 10 s, one in flight per endpoint,
  // through the delivery-time egress guard. Keyless, every attempt is cancelled as needs_rotation.
  const webhookOwnHosts = [env.API_PUBLIC_URL, env.WEB_PUBLIC_URL].flatMap((raw) => {
    try {
      return [new URL(raw).hostname];
    } catch {
      return [];
    }
  });
  const webhookDeps = {
    store: createWebhookDeliveryStore(database),
    cipher: createFieldCipher(loadFieldCipherKeyring(env)),
    ownHosts: webhookOwnHosts,
  };
  const webhookDeliveries = runWebhookRetrySweepLoop(async () => {
    const outcome = await sweepLock.run('webhooks', () => runWebhookDeliveryPass(webhookDeps));
    return outcome.ran ? outcome.result : { delivered: 0, failed: 0 };
  }, controller.signal);

  // GROWTH-FIX ---- the recurring jobs both hosts run (`jobs/scheduled-jobs.ts`): timers,
  // audit anchors, security detector, key rotation, the two purges, notification digest, growth
  // rollups, finance facts and both chain checks. Each pass runs under the job's named lock, the
  // same name the single app's `startScheduledJobs` takes, so the two never run one at once.
  const scheduledJobs = createScheduledJobs(database, env, {
    alerts: transport,
    notice,
  }).map((job) => runScheduledJobLoop(job, controller.signal, sweepLock));

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
    fanOut === undefined || directFanOut === undefined || realtime === undefined
      ? handlers
      : // 53-01: work events frame boards, lists and My Day, after their own consumers.
        withWorkFanOut(
          {
            ...handlers,
            'message.created.v1': mentions === undefined ? fanOut : both(mentions, fanOut),
            'direct_message.created.v1':
              directNotices === undefined ? directFanOut : both(directNotices, directFanOut),
          },
          createWorkFanOut(realtime.hub),
          both,
        );

  // x31. Two loops, one process, one `AbortSignal`: the notice queue drains beside the outbox
  // rather than behind it, so a backlog of events cannot delay a security receipt and a notice
  // handler cannot stall the relay. `Promise.all` keeps the shape the single loop had — either
  // loop leaves only by abort or by throwing, and a throw from either ends the process.
  try {
    await Promise.all([
      runOutboxLoop(database, withLinkPreviews(loopHandlers, database, realtime?.hub), {
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
    // ---- platform-admin v2 · PA-09 ----
    await exportJobs;
    // ---- R13-s2 ----
    await webhookDeliveries;
    // ---- EMAILBUILD2 ----
    await personMail;
    // ---- 62-A2 / 62-27 ----
    await activityProjector;
    await signalsSweep;
    // ---- 56-31 ----
    await mailDrain;
    // ---- GROWTH-FIX ----
    await Promise.all(scheduledJobs);
    await Promise.all([database.end(), sweepLock.end()]);
  }
}

main().catch((error: unknown) => {
  console.error('[worker] fatal', error);
  process.exitCode = 1;
});
