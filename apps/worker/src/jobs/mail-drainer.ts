import { randomUUID } from 'node:crypto';
import {
  HOST_MAIL_CEILING,
  MAILBOXES,
  MAIL_LANES,
  allowance,
  decodeQueuedMessage,
  effectiveCeiling,
  emailAddressHash,
  hourWindowStart,
  laneIsPaused,
  lanePausedSettingKey,
  mailboxCeilingSettingKey,
  parseCeiling,
} from '@tmanage/mail';
import type {
  MailLane,
  Mailbox,
  Mailer,
  MailMessage,
  MailReceipt,
  ReceiptMailer,
  SuppressionLookup,
} from '@tmanage/mail';
import type { ClaimedMail, MailQueueStore } from '../common/database/mail-queue-store.js';

/**
 * 56-31 — the mail drainer: the ONE place in the repository that submits to SMTP (a source-tree
 * test in packages/mail enforces it). Every 5 s it claims up to 50 `mail_queue` rows in lane
 * order `auth → transactional → digest → bulk`, oldest first, and sends each within its mailbox's
 * hour window (`mail_hour_windows`, shared by every process).
 *
 * - **Budget before claim.** A lane claims only what its mailbox may still send this hour
 *   (`allowance`: 10 % margin; on the shared noreply@ mailbox digest+bulk stop at 80 %). What
 *   does not fit is marked `deferred` until the next window — never dropped — and resumes there.
 * - **auth** goes from security@ when configured; past `deadline_at` it is `failed` (`deadline`),
 *   never sent late. When security@ rejects (auth failure, or ≥ 3 4xx replies in a window) the
 *   drainer falls back to noreply@ for the rest of that window, resending the failed row at once,
 *   and raises `mail_provider_degraded` once.
 * - **digest / bulk** re-check the suppression list (`suppressed`); auth and transactional never.
 * - **Alerts** (56-23 semantics on the alert hook): any deferred `auth` row → `auth_mail_deferred`
 *   (high); more than 50 deferred `transactional` rows → `transactional_mail_deferred`. Each kind
 *   at most once per hour window.
 * - **Retention**: rows purged 7 days on; an `auth` row's payload stripped 1 hour after sent.
 */

export const DRAIN_BATCH = 50;
export const DRAIN_INTERVAL_MS = 5_000;
export const STALE_SENDING_MS = 10 * 60 * 1000;
export const MAX_SEND_ATTEMPTS = 3;
const RETRY_BASE_MS = 60_000;
const HOUR_MS = 60 * 60 * 1000;
const PURGE_EVERY_MS = 10 * 60 * 1000;
const SECURITY_STORM = 3;
const TRANSACTIONAL_DEFERRED_ALERT = 50;

export type MailAlert = (
  kind: string,
  facts: Readonly<Record<string, string | number>>,
) => Promise<unknown>;

export interface MailDrainerDeps {
  readonly store: MailQueueStore;
  /** noreply@ — always present; the existing SMTP_* credentials. */
  readonly noreply: Mailer | ReceiptMailer;
  /** security@ — `SMTP_SECURITY_*`; absent = one mailbox, lane order still protects auth. */
  readonly security?: Mailer | ReceiptMailer | null;
  readonly suppressions?: SuppressionLookup | undefined;
  readonly alert?: MailAlert | undefined;
  readonly now?: () => Date;
  readonly newToken?: () => string;
  readonly log?: (line: string) => void;
}

/** What survives between ticks in one process. */
export interface MailDrainerState {
  /** The window (ms) in which security@ was found degraded; fallback lasts that window. */
  degradedWindow: number | null;
  securityFailures: { window: number; count: number };
  /** kind → window (ms) it was last raised in. */
  readonly alerted: Map<string, number>;
  lastPurgeAt: number;
}

export function createMailDrainerState(): MailDrainerState {
  return {
    degradedWindow: null,
    securityFailures: { window: 0, count: 0 },
    alerted: new Map(),
    lastPurgeAt: 0,
  };
}

export interface MailDrainReport {
  claimed: number;
  sent: number;
  deferred: number;
  failed: number;
  suppressed: number;
  retried: number;
  fellBack: number;
}

interface SmtpLikeError {
  readonly code?: unknown;
  readonly responseCode?: unknown;
}

function responseCodeOf(error: unknown): number | null {
  const code = (error as SmtpLikeError | null)?.responseCode;
  return typeof code === 'number' ? code : null;
}

/** 535/534/530 or nodemailer's EAUTH — the mailbox's credential is refused. */
export function isAuthFailure(error: unknown): boolean {
  const code = responseCodeOf(error);
  return (
    (error as SmtpLikeError | null)?.code === 'EAUTH' ||
    code === 535 ||
    code === 534 ||
    code === 530
  );
}

function isTemporaryRejection(error: unknown): boolean {
  const code = responseCodeOf(error);
  return code !== null && code >= 400 && code < 500;
}

/** A short, address-free error token for `mail_queue.error`. */
function errorToken(error: unknown): string {
  const response = responseCodeOf(error);
  if (response !== null) return `smtp_${String(response)}`;
  const code = (error as SmtpLikeError | null)?.code;
  if (typeof code === 'string' && /^[A-Z_]{2,32}$/u.test(code)) return `smtp_${code}`;
  return error instanceof Error ? error.name.slice(0, 64) : 'error';
}

async function submit(mailer: Mailer | ReceiptMailer, message: MailMessage): Promise<MailReceipt> {
  if ('submit' in mailer && typeof mailer.submit === 'function') return mailer.submit(message);
  return { delivery: await mailer.send(message), messageId: null };
}

function settingKeys(): string[] {
  return [
    ...MAILBOXES.map((mailbox) => mailboxCeilingSettingKey(mailbox)),
    ...MAIL_LANES.map((lane) => lanePausedSettingKey(lane)),
  ];
}

export async function drainMailOnce(
  deps: MailDrainerDeps,
  state: MailDrainerState,
): Promise<MailDrainReport> {
  const now = (deps.now ?? (() => new Date()))();
  const log = deps.log ?? ((line: string) => console.warn(line));
  const windowStart = hourWindowStart(now);
  const windowMs = windowStart.getTime();
  const nextWindow = new Date(windowMs + HOUR_MS);
  const report: MailDrainReport = {
    claimed: 0,
    sent: 0,
    deferred: 0,
    failed: 0,
    suppressed: 0,
    retried: 0,
    fellBack: 0,
  };

  const alertOnce = async (kind: string, facts: Record<string, string | number>) => {
    if (deps.alert === undefined || state.alerted.get(kind) === windowMs) return;
    state.alerted.set(kind, windowMs);
    try {
      await deps.alert(kind, facts);
    } catch {
      log(`[mail-drainer] could not raise ${kind}`);
    }
  };

  await deps.store.recoverStale(now, new Date(now.getTime() - STALE_SENDING_MS));
  await deps.store.requeueDue(now);

  const settings = await deps.store.settings(settingKeys());
  const ceiling: Record<Mailbox, number> = {
    security: parseCeiling(
      settings.get(mailboxCeilingSettingKey('security')),
      HOST_MAIL_CEILING.perHour,
    ),
    noreply: parseCeiling(
      settings.get(mailboxCeilingSettingKey('noreply')),
      HOST_MAIL_CEILING.perHour,
    ),
  };
  const stored = await deps.store.windowCounts(windowStart);
  const used: Record<Mailbox, number> = {
    security: stored.get('security') ?? 0,
    noreply: stored.get('noreply') ?? 0,
  };
  const securityUsable = (): boolean =>
    deps.security !== undefined && deps.security !== null && state.degradedWindow !== windowMs;

  // ---- plan and claim, lane by lane ----
  const token = (deps.newToken ?? randomUUID)();
  const planned: Record<Mailbox, number> = { security: used.security, noreply: used.noreply };
  const claimed: ClaimedMail[] = [];
  let room = DRAIN_BATCH;
  for (const lane of MAIL_LANES) {
    if (laneIsPaused(lane, settings.get(lanePausedSettingKey(lane)))) continue;
    let budget: number;
    if (lane === 'auth') {
      const own = securityUsable()
        ? allowance('auth', planned.security, ceiling.security, false)
        : 0;
      budget = own + allowance('auth', planned.noreply, ceiling.noreply, true);
    } else {
      budget = allowance(lane, planned.noreply, ceiling.noreply, true);
    }
    if (room === 0) break;
    const limit = Math.min(budget, room);
    const rows = limit > 0 ? await deps.store.claim(lane, limit, token, now) : [];
    claimed.push(...rows);
    room -= rows.length;
    // Plan the mailbox the rows will most likely use, so lower lanes see the spend.
    let toPlan = rows.length;
    if (lane === 'auth' && securityUsable()) {
      const onSecurity = Math.min(
        toPlan,
        Math.max(0, effectiveCeiling(ceiling.security) - planned.security),
      );
      planned.security += onSecurity;
      toPlan -= onSecurity;
    }
    planned.noreply += toPlan;
    // Budget-limited (not batch-limited): whatever is still queued waits for the next window.
    if (budget <= limit && rows.length === limit) {
      report.deferred += await deps.store.deferQueued(lane, now, nextWindow);
    }
  }
  report.claimed = claimed.length;

  // ---- send ----
  const mailerFor = (mailbox: Mailbox): Mailer | ReceiptMailer =>
    mailbox === 'security' && deps.security ? deps.security : deps.noreply;

  const pickMailbox = (lane: MailLane): Mailbox =>
    lane === 'auth' && securityUsable() && used.security < effectiveCeiling(ceiling.security)
      ? 'security'
      : 'noreply';

  for (const row of claimed) {
    if (
      row.lane === 'auth' &&
      row.deadlineAt !== null &&
      row.deadlineAt.getTime() <= now.getTime()
    ) {
      await deps.store.markFailed(row.id, token, 'deadline');
      report.failed += 1;
      continue;
    }
    const message = decodeQueuedMessage(row.payloadJson, row.templateKey);
    if (message === null) {
      await deps.store.markFailed(row.id, token, 'payload');
      report.failed += 1;
      continue;
    }
    if ((row.lane === 'digest' || row.lane === 'bulk') && deps.suppressions !== undefined) {
      let suppressed = false;
      try {
        suppressed = await deps.suppressions.isSuppressed(emailAddressHash(message.to));
      } catch {
        log('[mail-drainer] suppression lookup failed; sending');
      }
      if (suppressed) {
        await deps.store.markSuppressed(row.id, token);
        report.suppressed += 1;
        continue;
      }
    }

    let mailbox = pickMailbox(row.lane);
    let done = false;
    for (let attempt = 0; attempt < 2 && !done; attempt += 1) {
      // Counted before the attempt: the host counts a submission it then refuses, too.
      used[mailbox] += 1;
      await deps.store.countWindow(mailbox, windowStart);
      try {
        const receipt = await submit(mailerFor(mailbox), message);
        await deps.store.markSent(row.id, token, mailbox, now, receipt.messageId);
        report.sent += 1;
        done = true;
      } catch (error) {
        if (mailbox === 'security' && (isAuthFailure(error) || isTemporaryRejection(error))) {
          if (state.securityFailures.window !== windowMs) {
            state.securityFailures = { window: windowMs, count: 0 };
          }
          state.securityFailures.count += 1;
          if (isAuthFailure(error) || state.securityFailures.count >= SECURITY_STORM) {
            state.degradedWindow = windowMs;
            await alertOnce('mail_provider_degraded', {
              severity: 'high',
              mailbox: 'security',
              reason: errorToken(error),
            });
            // Fall back at the head of the queue: this row, now, through noreply@.
            mailbox = 'noreply';
            report.fellBack += 1;
            continue;
          }
        }
        if (row.attempts >= MAX_SEND_ATTEMPTS) {
          await deps.store.markFailed(row.id, token, errorToken(error));
          report.failed += 1;
        } else {
          const at = new Date(now.getTime() + RETRY_BASE_MS * Math.max(1, row.attempts));
          await deps.store.retryLater(row.id, token, at);
          report.retried += 1;
        }
        done = true;
      }
    }
  }

  // ---- alerts ----
  const deferred = await deps.store.deferredCounts();
  if (deferred.auth > 0) {
    await alertOnce('auth_mail_deferred', { severity: 'high', deferred: deferred.auth });
  }
  if (deferred.transactional > TRANSACTIONAL_DEFERRED_ALERT) {
    await alertOnce('transactional_mail_deferred', {
      severity: 'medium',
      deferred: deferred.transactional,
    });
  }

  // ---- retention ----
  if (now.getTime() - state.lastPurgeAt >= PURGE_EVERY_MS) {
    state.lastPurgeAt = now.getTime();
    await deps.store.purge(now);
  }
  return report;
}

/** The drain loop beside the relay: one tick every `intervalMs` until `signal` aborts. */
export async function runMailDrainLoop(
  deps: MailDrainerDeps,
  signal: AbortSignal,
  intervalMs = DRAIN_INTERVAL_MS,
): Promise<void> {
  const state = createMailDrainerState();
  const log = deps.log ?? ((line: string) => console.warn(line));
  while (!signal.aborted) {
    try {
      const report = await drainMailOnce(deps, state);
      if (report.claimed > 0 || report.deferred > 0) {
        log(
          `[mail-drainer] claimed ${String(report.claimed)}, sent ${String(report.sent)}, ` +
            `deferred ${String(report.deferred)}, failed ${String(report.failed)}, ` +
            `suppressed ${String(report.suppressed)}, retried ${String(report.retried)}`,
        );
      }
    } catch (error) {
      log(`[mail-drainer] tick failed: ${error instanceof Error ? error.name : 'error'}`);
    }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, intervalMs);
      signal.addEventListener(
        'abort',
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
    });
  }
}
