import { CONTACT_EMAILS } from '@tmanage/domain';
import {
  ConsoleMailer,
  SenderResolvingMailer,
  createIdentityMailers,
  deriveBounceKey,
  deriveUnsubscribeKey,
} from '@tmanage/mail';
import type { Mailer } from '@tmanage/mail';
import { createMailPeopleDirectory } from '../common/database/mail-people-store.js';
import type { WorkerDatabase } from '../common/database/worker-database.js';

/**
 * LANE-Q — the outreach campaign's own mail stack, built from the host's environment so both
 * hosts (the standalone worker and the single Hostinger app) get the same one from
 * `createScheduledJobs` without either composing it (PART.md W-10, PR-1).
 *
 * - SMTP: every introduction leaves from the signing person's own mailbox (ADR-0013,
 *   `PersonMailboxes`), signed in as that address with the shared SMTP_PASSWORD; replies come
 *   back to that mailbox. The identity mailers keep one pooled socket per mailbox (ST-1: the
 *   SMTP adapter's own connect/greeting/socket timeouts bound every send) and their own send
 *   ceiling, on top of the campaign's per-mailbox pace.
 * - The sender resolver picks the person from the recipient's assigned sender, fills the
 *   personal unsubscribe link and stamps the RFC 8058 `List-Unsubscribe` headers.
 * - `EMAIL_DRIVER=console` prints the mail instead (development).
 * - Without SESSION_SECRET (no unsubscribe or trial key) or, on SMTP, without SMTP_HOST and
 *   SMTP_PASSWORD there is no transport: the campaign job stays idle and says so once.
 */

export interface CampaignTransportEnv {
  readonly EMAIL_DRIVER?: string | undefined;
  readonly EMAIL_FROM_ADDRESS?: string | undefined;
  readonly EMAIL_FROM_NAME?: string | undefined;
  readonly EMAIL_SEND_AS?: boolean | undefined;
  readonly SMTP_HOST?: string | undefined;
  readonly SMTP_PORT?: number | undefined;
  readonly SMTP_SECURE?: boolean | undefined;
  readonly SMTP_USERNAME?: string | undefined;
  readonly SMTP_PASSWORD?: string | undefined;
  readonly SESSION_SECRET?: string | undefined;
  readonly API_PUBLIC_URL?: string | undefined;
}

export function createCampaignTransport(
  database: WorkerDatabase,
  env: CampaignTransportEnv,
): Mailer | null {
  const secret = (env.SESSION_SECRET ?? '').trim();
  const api = (env.API_PUBLIC_URL ?? '').trim();
  const identityAddress = (env.EMAIL_FROM_ADDRESS ?? '').trim() || CONTACT_EMAILS.noreply;
  if (secret === '' || api === '') return null;
  const from = { fromAddress: identityAddress, fromName: env.EMAIL_FROM_NAME ?? 'TManage' };
  let inner: Mailer;
  if (env.EMAIL_DRIVER === 'smtp') {
    const host = (env.SMTP_HOST ?? '').trim();
    if (host === '' || (env.SMTP_PASSWORD ?? '') === '') return null;
    inner = createIdentityMailers({
      base: {
        ...from,
        host,
        port: env.SMTP_PORT ?? 587,
        secure: env.SMTP_SECURE ?? false,
        username: env.SMTP_USERNAME,
        password: env.SMTP_PASSWORD,
        bounceKey: deriveBounceKey(secret),
      },
      hello: { address: CONTACT_EMAILS.hello },
      support: { address: CONTACT_EMAILS.support },
    });
  } else if (env.EMAIL_DRIVER === 'console') {
    inner = new ConsoleMailer(from);
  } else {
    return null;
  }
  return new SenderResolvingMailer(inner, {
    identityAddress,
    sendAs: env.EMAIL_SEND_AS ?? false,
    addresses: CONTACT_EMAILS,
    directory: createMailPeopleDirectory(database),
    unsubscribe: {
      url: `${api.replace(/\/+$/u, '')}/v1/public/email/unsubscribe`,
      key: deriveUnsubscribeKey(secret),
    },
  });
}
