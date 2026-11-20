import { SmtpMailer } from './smtp-mailer.js';
import type { SmtpMailerOptions } from './smtp-mailer.js';

/**
 * PERSONMAIL / MAILSTATUS (ADR-0013; owner decision 2026-11-20: every mailbox shares ONE password).
 *
 * One rule for every role mailbox (hello, support, security): it signs in with its own username
 * (`SMTP_HELLO_USER`, …; default its own address) and its own password when set
 * (`SMTP_HELLO_PASS`, …), otherwise the shared `SMTP_PASSWORD`. A mailbox with no username or
 * no password at all has no login.
 */
export interface MailboxLoginInput {
  /** The mailbox's own username override (`SMTP_HELLO_USER`, `SMTP_SECURITY_USERNAME`, …). */
  readonly username?: string | undefined;
  /** The mailbox's own password override (`SMTP_HELLO_PASS`, `SMTP_SECURITY_PASSWORD`, …). */
  readonly password?: string | undefined;
  /** The mailbox's own address, the default username. */
  readonly address?: string | undefined;
}

export interface MailboxLogin {
  readonly username: string;
  readonly password: string;
}

export function resolveMailboxLogin(
  login: MailboxLoginInput | undefined,
  shared: string | undefined,
): MailboxLogin | null {
  const username = login?.username?.trim() || login?.address?.trim() || '';
  const password = login?.password || shared || '';
  if (username === '' || !username.includes('@') || password === '') return null;
  return { username, password };
}

/** The role mailboxes whose login is checked. Person mailboxes are reported by the sender. */
export const CHECKED_MAILBOXES = ['noreply', 'hello', 'support', 'security'] as const;
export type CheckedMailbox = (typeof CHECKED_MAILBOXES)[number];

/**
 * `ok`: the server accepted the login. `login_refused`: 535/534/530/EAUTH (the password or user
 * is wrong). `unreachable`: no answer, TLS or another error. `not_configured`: no login set.
 */
export type MailboxLoginState = 'ok' | 'login_refused' | 'unreachable' | 'not_configured';

export interface MailboxLoginReading {
  readonly mailbox: CheckedMailbox;
  /** The username that signs in (an address, never a password); `null` when not configured. */
  readonly address: string | null;
  readonly state: MailboxLoginState;
}

export interface MailboxLoginStatus {
  /** The worst state across the configured mailboxes (`not_configured` only when none is). */
  readonly state: MailboxLoginState;
  readonly mailboxes: readonly MailboxLoginReading[];
  readonly checkedAt: string;
}

/** How long one reading stands: the check signs in to every mailbox, so it is bounded. */
export const MAIL_LOGIN_CHECK_TTL_MS = 15 * 60_000;

const RANK: Readonly<Record<MailboxLoginState, number>> = {
  not_configured: 0,
  ok: 1,
  unreachable: 2,
  login_refused: 3,
};

/** 535/534/530 or nodemailer's EAUTH: the mailbox's credential is refused. */
export function isSmtpAuthFailure(error: unknown): boolean {
  const failure = error as { readonly code?: unknown; readonly responseCode?: unknown } | null;
  const code = typeof failure?.responseCode === 'number' ? failure.responseCode : null;
  return failure?.code === 'EAUTH' || code === 535 || code === 534 || code === 530;
}

export interface MailLoginCheckOptions {
  /** Each role mailbox's SMTP options; `null` = not configured. */
  readonly targets: Readonly<Record<CheckedMailbox, SmtpMailerOptions | null>>;
  /** How one login is checked; default: `SmtpMailer.verify()` (sign in, quit, send nothing). */
  readonly verify?: ((options: SmtpMailerOptions) => Promise<void>) | undefined;
  readonly ttlMs?: number | undefined;
  readonly now?: (() => number) | undefined;
  readonly log?: ((line: string) => void) | undefined;
}

/**
 * MAILSTATUS. Whether each role mailbox's login is accepted, for `/healthz/deep` and the platform
 * settings card. Readings are cached ({@link MAIL_LOGIN_CHECK_TTL_MS}) and concurrent reads share
 * one check, so a public poller cannot turn it into repeated SMTP logins. Only states and
 * usernames leave this class: never a password, never the server's error text.
 */
export class MailLoginCheck {
  private cached: { readonly at: number; readonly status: MailboxLoginStatus } | null = null;
  private pending: Promise<MailboxLoginStatus> | null = null;
  private readonly verify: (options: SmtpMailerOptions) => Promise<void>;
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly log: (line: string) => void;

  constructor(private readonly options: MailLoginCheckOptions) {
    this.verify =
      options.verify ??
      (async (smtp) => {
        const mailer = new SmtpMailer(smtp);
        try {
          await mailer.verify();
        } finally {
          mailer.close();
        }
      });
    this.now = options.now ?? (() => Date.now());
    this.ttlMs = options.ttlMs ?? MAIL_LOGIN_CHECK_TTL_MS;
    this.log = options.log ?? ((line: string) => console.warn(line));
  }

  async status(): Promise<MailboxLoginStatus> {
    const at = this.now();
    if (this.cached !== null && at - this.cached.at < this.ttlMs) return this.cached.status;
    this.pending ??= this.check(at).finally(() => {
      this.pending = null;
    });
    return this.pending;
  }

  /**
   * The last reading without waiting (for a public poller): starts a check when there is none or it
   * is stale, and answers `null` until the first one finishes.
   */
  latest(): MailboxLoginStatus | null {
    const at = this.now();
    if (this.cached === null || at - this.cached.at >= this.ttlMs) {
      void this.status().catch(() => undefined);
    }
    return this.cached?.status ?? null;
  }

  private async check(at: number): Promise<MailboxLoginStatus> {
    const mailboxes = await Promise.all(
      CHECKED_MAILBOXES.map(async (mailbox): Promise<MailboxLoginReading> => {
        const target = this.options.targets[mailbox];
        const address = target?.username?.trim() || null;
        if (target === null || address === null || !target.password) {
          return { mailbox, address: null, state: 'not_configured' };
        }
        try {
          await this.verify(target);
          return { mailbox, address, state: 'ok' };
        } catch (error) {
          return {
            mailbox,
            address,
            state: isSmtpAuthFailure(error) ? 'login_refused' : 'unreachable',
          };
        }
      }),
    );
    const failing = mailboxes.filter(
      (m) => m.state === 'login_refused' || m.state === 'unreachable',
    );
    if (failing.length > 0) {
      // Names and states only: the reason a mailbox cannot sign in, never a value.
      this.log(
        `[mailer] mailbox login check: ${failing.map((m) => `${m.mailbox} ${m.state}`).join(', ')}`,
      );
    }
    const state = mailboxes.reduce<MailboxLoginState>(
      (worst, m) => (RANK[m.state] > RANK[worst] ? m.state : worst),
      'not_configured',
    );
    const status = { state, mailboxes, checkedAt: new Date(at).toISOString() };
    this.cached = { at, status };
    return status;
  }
}
