import type { OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { uuidv7 } from '@tmanage/domain';
import { serializeForLog } from '../../common/observability/logger.js';
import type { UnconfirmedAccount } from './password-reset.repository.js';
import type { EmailConfirmationRequest } from './password-reset.service.js';

/**
 * RESENDVERIFY (2026-11-24) — the "Confirm your e-mail" reminders.
 *
 * The hourly person-mail sweep (`apps/worker/src/common/database/person-mail-store.ts`) mails only
 * members whose address is confirmed, so a person who signed up with a password and never clicked
 * the link heard nothing more (live case: an owner away for days got no follow-up). This pass sends
 * them the ordinary confirmation link — `EmailConfirmationService.requestForAccount`, the same
 * token and mail as the self-service and Platform admin resends, signed through the sender
 * resolver under the `password_reset` template key (topic `security`, "TManage Security") — at
 * about 1, 3 and 7 days after sign-up, then stops. Rules, all in {@link dueReminderDay} and
 * unit-tested:
 *
 * - never in the first 24 hours; each reminder has a window ({@link REMINDER_WINDOW_DAYS} days)
 *   after its day, so an account older than 9 days (the "old unverified people") is never mailed
 *   by this pass: that is the Platform admin's bulk send;
 * - each reminder day at most once per person ever (`email_confirmation_reminders`, claimed with
 *   `INSERT IGNORE` on the primary key before the send, AS-2), and never two reminders within
 *   24 hours of each other;
 * - only an active password account (`requestForAccount`), with no open link (a link mailed in
 *   the last 30 minutes still works);
 * - the per-address bound (3 an hour) and a global bound of {@link REMINDER_MAX_PER_HOUR} links
 *   an hour are the confirmation service's own (`createPasswordResetMailBudget`);
 * - the platform switch "Tips and reminders" (`platform_settings` `mail.tips_enabled`, `on`;
 *   absent = off) stops it, exactly as it stops the tips.
 *
 * Two processes can run it at once (RT-3): the claim decides who sends, and the state that says
 * a reminder went out lives in the database, not in memory (AS-4). A claimed reminder whose send
 * did not happen (`not_sent`) is not retried; the next reminder is the retry.
 *
 * Runs in-process (the single Hostinger app has no cron), hourly, off unless
 * `WORKER_INPROCESS=1` or `EMAIL_CONFIRMATION_REMINDERS_INPROCESS=1`, like the other API jobs.
 */

export const REMINDER_DAYS = [1, 3, 7] as const;
export type ReminderDay = (typeof REMINDER_DAYS)[number];
/** How long after its day a reminder may still go out. */
export const REMINDER_WINDOW_DAYS = 2;
/** People looked at per run (the newest window holds at most 9 days of sign-ups). */
export const REMINDER_BATCH = 50;
/** Links this pass may send an hour, beside the mailbox's ~300 (`HOST_MAIL_CEILING`). */
export const REMINDER_MAX_PER_HOUR = 50;
/**
 * `platform-admin/settings/person-mail.repository.ts` TIPS_SWITCH_KEY (the switch's owner; this
 * module may not import it, AR-5). `email-confirmation-reminders.test.ts` holds the two equal.
 */
export const REMINDER_SWITCH_KEY = 'mail.tips_enabled';

export const DAY_MS = 86_400_000;

/**
 * Which reminder is due for an account created at `createdAt`, given the reminders it was already
 * sent (day → when), or `null`. Pure; the whole schedule is here.
 */
export function dueReminderDay(
  createdAt: Date,
  now: Date,
  sent: ReadonlyMap<number, Date>,
): ReminderDay | null {
  const age = now.getTime() - createdAt.getTime();
  if (age < DAY_MS) return null;
  for (const lastSent of sent.values()) {
    if (now.getTime() - lastSent.getTime() < DAY_MS) return null;
  }
  for (let index = REMINDER_DAYS.length - 1; index >= 0; index -= 1) {
    const day = REMINDER_DAYS[index] as ReminderDay;
    if (age < day * DAY_MS) continue;
    if (age >= (day + REMINDER_WINDOW_DAYS) * DAY_MS) return null;
    return sent.has(day) ? null : day;
  }
  return null;
}

/** The slice of `EmailConfirmationService` the pass uses. */
export interface ReminderSender {
  requestForAccount(
    userId: string,
    context: { readonly correlationId: string },
  ): Promise<EmailConfirmationRequest>;
}

/** The database steps the pass takes (`reminderStore`, `email-confirmation-reminders.repository.ts`). */
export interface ReminderStore {
  switchOn(correlationId: string): Promise<boolean>;
  candidates(correlationId: string, now: Date): Promise<readonly UnconfirmedAccount[]>;
  sentTo(
    correlationId: string,
    userIds: readonly string[],
  ): Promise<ReadonlyMap<string, ReadonlyMap<number, Date>>>;
  claim(correlationId: string, userId: string, day: ReminderDay, at: Date): Promise<boolean>;
  settle(
    correlationId: string,
    userId: string,
    day: ReminderDay,
    result: EmailConfirmationRequest,
  ): Promise<void>;
}

export interface ReminderPassReport {
  readonly looked: number;
  readonly sent: number;
  readonly notSent: number;
}

/** One run: who is due, claim, send, record. */
export class EmailConfirmationReminderPass {
  constructor(
    private readonly store: ReminderStore,
    private readonly sender: ReminderSender,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async run(): Promise<ReminderPassReport> {
    const correlationId = uuidv7();
    if (!(await this.store.switchOn(correlationId))) return { looked: 0, sent: 0, notSent: 0 };
    const now = this.now();
    const accounts = await this.store.candidates(correlationId, now);
    const sent = await this.store.sentTo(
      correlationId,
      accounts.map((account) => account.userId),
    );
    let mailed = 0;
    let notSent = 0;
    for (const account of accounts) {
      const day = dueReminderDay(account.createdAt, now, sent.get(account.userId) ?? new Map());
      if (day === null) continue;
      if (!(await this.store.claim(correlationId, account.userId, day, now))) continue;
      const result = await this.sender.requestForAccount(account.userId, { correlationId });
      await this.store.settle(correlationId, account.userId, day, result);
      if (result === 'sent') mailed += 1;
      else notSent += 1;
    }
    return { looked: accounts.length, sent: mailed, notSent };
  }
}

export const EMAIL_CONFIRMATION_REMINDER_JOB = Symbol.for('tmanage.EmailConfirmationReminderJob');

export function emailConfirmationRemindersEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env['WORKER_INPROCESS'] === '1' || env['EMAIL_CONFIRMATION_REMINDERS_INPROCESS'] === '1';
}

export interface ReminderJobOptions {
  readonly bootDelayMs: number;
  readonly intervalMs: number;
  readonly log: (line: string) => void;
}

export const DEFAULT_REMINDER_JOB_OPTIONS: ReminderJobOptions = {
  bootDelayMs: 5 * 60_000,
  intervalMs: 60 * 60_000,
  log: (line) => console.warn(line),
};

/** The hourly timer around {@link EmailConfirmationReminderPass}; one run at a time. */
export class EmailConfirmationReminderJob implements OnApplicationBootstrap, OnModuleDestroy {
  private running: Promise<void> | null = null;
  private boot: NodeJS.Timeout | null = null;
  private interval: NodeJS.Timeout | null = null;
  private stopped = false;

  constructor(
    private readonly pass: Pick<EmailConfirmationReminderPass, 'run'>,
    private readonly enabled: boolean,
    private readonly options: ReminderJobOptions = DEFAULT_REMINDER_JOB_OPTIONS,
  ) {}

  onApplicationBootstrap(): void {
    if (!this.enabled) return;
    this.boot = setTimeout(() => this.tick(), this.options.bootDelayMs);
    this.boot.unref();
    this.interval = setInterval(() => this.tick(), this.options.intervalMs);
    this.interval.unref();
  }

  async onModuleDestroy(): Promise<void> {
    this.stopped = true;
    if (this.boot) clearTimeout(this.boot);
    if (this.interval) clearInterval(this.interval);
    this.boot = null;
    this.interval = null;
    await this.running;
  }

  /** Start a run unless one is going or the job stopped. Returns the run, for tests. */
  tick(): Promise<void> | null {
    if (this.stopped || this.running) return null;
    this.running = this.runOnce().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  private async runOnce(): Promise<void> {
    try {
      const report = await this.pass.run();
      if (report.sent + report.notSent > 0) {
        this.options.log(
          `[email-confirmation-reminders] sent ${report.sent}, not sent ${report.notSent} of ${report.looked} looked at`,
        );
      }
    } catch (error) {
      console.error('[email-confirmation-reminders] run failed', serializeForLog(error));
    }
  }
}
