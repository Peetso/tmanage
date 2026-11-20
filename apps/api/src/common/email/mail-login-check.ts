import { CONTACT_EMAILS } from '@tmanage/domain';
import { MailLoginCheck, resolveMailboxLogin } from '@tmanage/mail';
import type { CheckedMailbox, MailboxLoginInput, SmtpMailerOptions } from '@tmanage/mail';

/**
 * MAILSTATUS (ADR-0013). The role mailboxes' login check, shared by `/healthz/deep` (one overall
 * state) and the platform settings "E-mail people" card (a state per mailbox). `null` when mail
 * does not go out over SMTP. Each mailbox signs in as its own username with its own password when
 * set, otherwise the shared `SMTP_PASSWORD` (owner decision 2026-11-20).
 */
export { MAIL_LOGIN_CHECK } from '../http/tokens.js';

export interface MailLoginCheckConfig {
  readonly driver: string;
  readonly smtpHost?: string | undefined;
  readonly smtpPort?: number | undefined;
  readonly smtpSecure?: boolean | undefined;
  readonly smtpUsername?: string | undefined;
  readonly smtpPassword?: string | undefined;
  readonly fromAddress: string;
  readonly fromName: string;
  readonly helloLogin?: MailboxLoginInput | undefined;
  readonly supportLogin?: MailboxLoginInput | undefined;
  readonly securityLogin?: MailboxLoginInput | undefined;
}

export function mailLoginCheckFrom(config: MailLoginCheckConfig): MailLoginCheck | null {
  const host = config.smtpHost?.trim() ?? '';
  if (config.driver !== 'smtp' || host === '') return null;
  const shared = config.smtpPassword;
  const smtp = (username: string, password: string): SmtpMailerOptions => ({
    host,
    port: config.smtpPort ?? 587,
    secure: config.smtpSecure ?? false,
    username,
    password,
    fromAddress: username,
    fromName: config.fromName,
  });
  const role = (login: MailboxLoginInput | undefined): SmtpMailerOptions | null => {
    const resolved = resolveMailboxLogin(login, shared);
    return resolved === null ? null : smtp(resolved.username, resolved.password);
  };
  const targets: Record<CheckedMailbox, SmtpMailerOptions | null> = {
    noreply: role({ username: config.smtpUsername, address: config.fromAddress }),
    hello: role({ address: CONTACT_EMAILS.hello, ...config.helloLogin }),
    support: role({ address: CONTACT_EMAILS.support, ...config.supportLogin }),
    security: role(config.securityLogin),
  };
  return new MailLoginCheck({ targets });
}
