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
import { SmtpMailer } from './smtp-mailer.js';
import type { SmtpMailerOptions } from './smtp-mailer.js';

/**
 * EMAILBUILD (amendment 3) — every kind of mail leaves through its own real mailbox.
 *
 * `noreply` (codes, security, notices, agency and internal mail) is the existing SMTP login;
 * `hello` (welcome) and `support` (support answers and every person mail) have their own logins
 * on the same host. The sender resolver puts the key on the message; this router sends through
 * that mailbox, each behind its own send ceiling (so one mailbox's notices never spend another's
 * budget, and inside one mailbox codes keep the headroom bulk mail may not use). A mailbox whose
 * login is not configured is replaced by `noreply`, said once at construction, never per mail.
 */

export class IdentityRoutingMailer implements ReceiptMailer {
  constructor(private readonly mailers: Readonly<Record<MailIdentity, ReceiptMailer>>) {}

  async send(message: MailMessage): Promise<MailDelivery> {
    return (await this.submit(message)).delivery;
  }

  submit(message: MailMessage): Promise<MailReceipt> {
    const key: MailIdentity =
      message.identity === 'hello' || message.identity === 'support' ? message.identity : 'noreply';
    return this.mailers[key].submit(message);
  }
}

/** One extra mailbox login (`SMTP_HELLO_USER` / `SMTP_HELLO_PASS`, …); the user is the address. */
export interface IdentityLogin {
  readonly username?: string | undefined;
  readonly password?: string | undefined;
}

export interface IdentityMailersOptions {
  /** The noreply driver's options: host, port, TLS, bounce key, and its own login. */
  readonly base: SmtpMailerOptions;
  readonly hello?: IdentityLogin | undefined;
  readonly support?: IdentityLogin | undefined;
  readonly ceiling?: SendCeiling | undefined;
  readonly log?: ((line: string) => void) | undefined;
  /** The noreply transport already built (the existing driver); absent = one built from `base`. */
  readonly noreply?: Mailer | undefined;
  /** How a mailbox's driver is built; a suite passes a fake. Default: a pooled `SmtpMailer`. */
  readonly build?: ((options: SmtpMailerOptions) => Mailer) | undefined;
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
  const missing: MailIdentity[] = [];
  const build = (key: 'hello' | 'support', login: IdentityLogin | undefined): ReceiptMailer => {
    const username = login?.username?.trim();
    const password = login?.password;
    if (!username || !password || !username.includes('@')) {
      missing.push(key);
      return noreply;
    }
    return new SendCeilingMailer(
      make({ ...options.base, fromAddress: username, username, password, pooled: true }),
      ceiling,
    );
  };
  const mailers = {
    noreply,
    hello: build('hello', options.hello),
    support: build('support', options.support),
  };
  if (missing.length > 0) {
    log(`[mailer] no login for ${missing.join(', ')}; that mail leaves through noreply`);
  }
  return new IdentityRoutingMailer(mailers);
}
