import type {
  MailDelivery,
  MailIdentity,
  Mailer,
  MailMessage,
  MailReceipt,
  ReceiptMailer,
} from './mailer.js';
import { HOST_MAIL_CEILING, SendCeilingMailer } from './send-ceiling.js';
import type { SendCeiling } from './send-ceiling.js';
import { addressDomain, validateSenderAddress } from './sender.js';
import { isSmtpAuthFailure, resolveMailboxLogin } from './mailbox-login.js';
import type { MailboxLoginInput } from './mailbox-login.js';
import { SmtpMailer } from './smtp-mailer.js';
import type { SmtpMailerOptions } from './smtp-mailer.js';

/**
 * EMAILBUILD (amendment 3) — every kind of mail leaves through its own real mailbox.
 *
 * `noreply` (codes, security, notices, agency and internal mail) is the existing SMTP login;
 * `hello` (welcome) and `support` (support answers) have their own logins on the same host. The
 * sender resolver puts the key on the message; this router sends through that mailbox, each behind
 * its own send ceiling (so one mailbox's notices never spend another's budget, and inside one
 * mailbox codes keep the headroom bulk mail may not use). A mailbox whose login is not configured
 * is replaced by `noreply`, said once at construction, never per mail.
 *
 * PERSONMAIL (correction 4, ADR-0013; owner decisions 2026-11-20) — a person mail (`identity:
 * 'person'`, template `tip`) leaves ONLY from the signing person's OWN mailbox over SMTP: the login
 * is the person's own address, the password the one shared mailbox password (`SMTP_PASSWORD`).
 * SMTP carries every header, so the mail keeps `List-Unsubscribe` and `Auto-Submitted`. It is
 * never sent from another mailbox in the person's name: when that login fails (one WARN per
 * address) or the mailbox's own ceiling is reached, the send throws, the queue retries the row and
 * after its last attempt marks it failed with the reason (the drainer's existing path).
 *
 * `hello` and `support` sign in as their own address too: `SMTP_HELLO_PASS` / `SMTP_SUPPORT_PASS`
 * only override the shared password.
 */

export { isSmtpAuthFailure };

/** A driver that can be closed (a pooled `SmtpMailer`); a suite's fake need not be. */
type ClosableMailer = Mailer & { close?: () => void };

export interface PersonMailboxesOptions {
  /** Host, port, TLS and bounce key of the mail host; the login is the person's own. */
  readonly base: SmtpMailerOptions;
  /** The shared mailbox password (`SMTP_PASSWORD`); the username is the person's own address. */
  readonly password: string;
  readonly ceiling?: SendCeiling | undefined;
  readonly build?: ((options: SmtpMailerOptions) => ClosableMailer) | undefined;
  readonly log?: ((line: string) => void) | undefined;
  readonly now?: (() => number) | undefined;
}

/** A person mailbox's pooled connection is closed after this long unused. */
export const PERSON_IDLE_CLOSE_MS = 10 * 60_000;

interface PersonTransport {
  readonly mailer: ClosableMailer;
  lastUsed: number;
}

/** Thrown when a person mail has no valid own mailbox address, or no shared password is set. */
export class PersonMailboxUnavailableError extends Error {
  readonly code = 'EPERSONMAILBOX';
  constructor(reason: string) {
    super(`person mailbox unavailable: ${reason}`);
    this.name = 'PersonMailboxUnavailableError';
  }
}

/**
 * The person mailboxes: one lazy pooled SMTP transport per address (max 1 connection each, closed
 * when idle), each behind its own send ceiling keyed on the sending address.
 */
export class PersonMailboxes {
  private readonly transports = new Map<string, PersonTransport>();
  private readonly ceilings = new Map<string, SendCeilingMailer>();
  private readonly warned = new Set<string>();
  private readonly ceiling: SendCeiling;
  private readonly make: (options: SmtpMailerOptions) => ClosableMailer;
  private readonly log: (line: string) => void;
  private readonly now: () => number;
  private readonly domain: string;

  constructor(private readonly options: PersonMailboxesOptions) {
    this.ceiling = options.ceiling ?? HOST_MAIL_CEILING;
    this.make = options.build ?? ((smtp: SmtpMailerOptions) => new SmtpMailer(smtp));
    this.log = options.log ?? ((line: string) => console.warn(line));
    this.now = options.now ?? (() => Date.now());
    this.domain = addressDomain(options.base.fromAddress);
  }

  /** Send from the person's own mailbox; any failure throws for the queue (see the module doc). */
  async submit(message: MailMessage): Promise<MailReceipt> {
    this.closeIdle();
    const address = message.from?.address;
    if (address === undefined || !validateSenderAddress(address, this.domain)) {
      throw new PersonMailboxUnavailableError('no valid own address');
    }
    try {
      return await this.ceilingFor(address).submit({ ...message, identity: 'person' });
    } catch (error) {
      if (isSmtpAuthFailure(error)) {
        // The mailbox refused the shared password (or does not exist): rebuild on the next try.
        this.drop(address);
        this.warnOnce(
          `auth:${address}`,
          '[mailer] a person mailbox refused its login; the mail is retried, then marked failed',
        );
      }
      throw error;
    }
  }

  /** The address's ceiling (kept when its transport is rebuilt) over its current transport. */
  private ceilingFor(address: string): SendCeilingMailer {
    if (!this.transports.has(address)) {
      this.transports.set(address, {
        mailer: this.make({
          ...this.options.base,
          fromAddress: address,
          username: address,
          password: this.options.password,
          pooled: true,
        }),
        lastUsed: this.now(),
      });
    }
    const entry = this.transports.get(address) as PersonTransport;
    entry.lastUsed = this.now();
    let ceiling = this.ceilings.get(address);
    if (ceiling === undefined) {
      // The ceiling outlives a transport rebuilt after a refusal: it counts the address.
      const current = (): Mailer & Partial<ReceiptMailer> =>
        this.transports.get(address)?.mailer ?? entry.mailer;
      const through: ReceiptMailer = {
        send: (m) => current().send(m),
        submit: async (m) => {
          const mailer = current();
          if (typeof mailer.submit === 'function') return mailer.submit(m);
          return { delivery: await mailer.send(m), messageId: null };
        },
      };
      ceiling = new SendCeilingMailer(through, this.ceiling, this.now);
      this.ceilings.set(address, ceiling);
    }
    return ceiling;
  }

  private drop(address: string): void {
    const entry = this.transports.get(address);
    if (entry === undefined) return;
    this.transports.delete(address);
    entry.mailer.close?.();
  }

  private closeIdle(): void {
    const cutoff = this.now() - PERSON_IDLE_CLOSE_MS;
    for (const [address, entry] of this.transports) {
      if (entry.lastUsed < cutoff) this.drop(address);
    }
  }

  private warnOnce(key: string, line: string): void {
    if (this.warned.has(key)) return;
    this.warned.add(key);
    this.log(line);
  }
}

export class IdentityRoutingMailer implements ReceiptMailer {
  constructor(
    private readonly mailers: Readonly<Record<Exclude<MailIdentity, 'person'>, ReceiptMailer>>,
    private readonly people?: PersonMailboxes | undefined,
  ) {}

  async send(message: MailMessage): Promise<MailDelivery> {
    return (await this.submit(message)).delivery;
  }

  submit(message: MailMessage): Promise<MailReceipt> {
    if (message.identity === 'person') {
      // Never another mailbox in the person's name (owner decision): no login = the send fails.
      if (this.people !== undefined) return this.people.submit(message);
      return Promise.reject(new PersonMailboxUnavailableError('no shared mailbox password'));
    }
    const key =
      message.identity === 'hello' || message.identity === 'support' || message.identity === 'sales'
        ? message.identity
        : 'noreply';
    return this.mailers[key].submit(message);
  }
}

/**
 * One extra mailbox login: `SMTP_HELLO_USER` / `SMTP_HELLO_PASS`, … The username is that mailbox's
 * own address (`address` when no user is set); without its own password it uses the shared one.
 */
export type IdentityLogin = MailboxLoginInput;

export interface IdentityMailersOptions {
  /** The noreply driver's options: host, port, TLS, bounce key, and its own login. */
  readonly base: SmtpMailerOptions;
  readonly hello?: IdentityLogin | undefined;
  readonly support?: IdentityLogin | undefined;
  /** LANE-Q: sales@ (walkthrough requests), signed in like hello and support. */
  readonly sales?: IdentityLogin | undefined;
  /**
   * PERSONMAIL. Person mail signs in as the person's own address with the shared password
   * (`base.password`). Default on; off (or no shared password) = person mail fails, never resent.
   */
  readonly personMail?: boolean | undefined;
  readonly ceiling?: SendCeiling | undefined;
  readonly log?: ((line: string) => void) | undefined;
  /** The noreply transport already built (the existing driver); absent = one built from `base`. */
  readonly noreply?: Mailer | undefined;
  /** How a mailbox's driver is built; a suite passes a fake. Default: a pooled `SmtpMailer`. */
  readonly build?: ((options: SmtpMailerOptions) => ClosableMailer) | undefined;
  readonly now?: (() => number) | undefined;
}

/** The router over the configured mailboxes, each behind its own ceiling. */
export function createIdentityMailers(options: IdentityMailersOptions): IdentityRoutingMailer {
  const ceiling = options.ceiling ?? HOST_MAIL_CEILING;
  const log = options.log ?? ((line: string) => console.warn(line));
  const make = options.build ?? ((smtp: SmtpMailerOptions) => new SmtpMailer(smtp));
  const noreply = new SendCeilingMailer(
    options.noreply ?? make({ ...options.base, pooled: true }),
    ceiling,
  );
  const shared = options.base.password;
  const missing: MailIdentity[] = [];
  const build = (
    key: 'hello' | 'support' | 'sales',
    login: IdentityLogin | undefined,
  ): ReceiptMailer => {
    // Its own address signs in; its own password only overrides the shared one (owner decision).
    const resolved = resolveMailboxLogin(login, shared);
    if (resolved === null) {
      missing.push(key);
      return noreply;
    }
    const { username, password } = resolved;
    return new SendCeilingMailer(
      make({ ...options.base, fromAddress: username, username, password, pooled: true }),
      ceiling,
    );
  };
  const mailers = {
    noreply,
    hello: build('hello', options.hello),
    support: build('support', options.support),
    // LANE-Q: a host that names no sales login keeps the earlier routes (noreply), unannounced.
    sales: options.sales === undefined ? noreply : build('sales', options.sales),
  };
  if (missing.length > 0) {
    log(`[mailer] no login for ${missing.join(', ')}; that mail leaves through noreply`);
  }
  const people =
    options.personMail === false || !shared
      ? undefined
      : new PersonMailboxes({
          base: options.base,
          password: shared,
          ceiling,
          build: make,
          log,
          now: options.now,
        });
  if (people === undefined) {
    log('[mailer] no shared mailbox password; person mail cannot be sent');
  }
  return new IdentityRoutingMailer(mailers, people);
}
