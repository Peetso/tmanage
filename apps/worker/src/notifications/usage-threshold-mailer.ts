import type { Mailer, MailMessage } from '@tmanage/mail';

/**
 * USAGE-001 slice 4c's storage-threshold receipt, as an email — the relay's fourth producer on
 * the `@tmanage/mail` port, and the sibling of {@link CredentialChangeMailer} rather than of
 * {@link ClientRequestMailer}: it carries no client-request facts and, like the credential
 * receipt, **no link**.
 *
 * ## What it says, and the one thing it deliberately does not
 *
 * `35-NOTIFICATION-AND-EMAIL-COPY` §1's copy for the in-app notice is "Storage at 85% — 8.5 GB
 * of 10 GB"; the mail says the same sentence, rendered from the event payload the x63 producer
 * writes (`band`, `used`, `reserved`, `quota` — bytes). It is content-bearing rather than a
 * reference, which an email must be: unlike a notification row it has no display time at which
 * to resolve the number, so the figure is the one true at the crossing, stated as such.
 *
 * - **No link.** The only place these bytes are shown is the billing/usage screen, which is a
 *   later USAGE-001 slice and does not exist yet (x68 rendered the inbox line with no route for
 *   exactly this reason). A link invented for a screen that is not built would be a dead end, so
 *   the mail names the destination in words and stops there, as the credential receipt does for
 *   its own reason.
 *
 * `deliver` never throws: it runs on the far side of the batch's commit, where a throw could not
 * un-publish the event it belongs to, so it absorbs the transport error into the operator's log
 * and reports `'failed'` — the shape both existing relay mailers have.
 */

/** Bytes as a short human string, binary units — "8.5 GB", "512 MB". Mirrors `InboxScreen`. */
function formatBytes(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const rounded = Math.round(value * 10) / 10;
  const text = Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
  return `${text} ${units[unit]}`;
}

/** Flattened before it reaches a header: a display name is a string a person typed. */
function oneLine(value: string): string {
  return value.replaceAll(/\s+/gu, ' ').trim();
}

/** Everything one usage mail says, resolved from the payload and the recipient's user row. */
export interface UsageThresholdEmailFacts {
  readonly recipientEmail: string;
  readonly recipientName: string;
  /** The band crossed: 70, 85, 95 (a warning) or 100 (uploads now blocked). */
  readonly band: number;
  readonly used: number;
  readonly reserved: number;
  readonly quota: number;
}

/**
 * The message for one crossing. The 100 band reads differently from the warnings, because at
 * 100 new reservations are already refused and the owner needs to know uploads have *stopped*,
 * not that they are near a limit.
 */
export function composeUsageThresholdEmail(facts: UsageThresholdEmailFacts): MailMessage {
  const name = oneLine(facts.recipientName);
  const held = `${formatBytes(facts.used + facts.reserved)} of ${formatBytes(facts.quota)}`;
  const blocked = facts.band >= 100;
  const subject = blocked
    ? 'Your TManage storage is full — new uploads are blocked'
    : `Your TManage storage is at ${facts.band}%`;
  const middle = blocked
    ? `Your organization's storage is full (${held}). New uploads are blocked until usage ` +
      `drops or the plan's limit is raised.`
    : `Your organization's storage is at ${facts.band}% (${held}). New uploads are still ` +
      `accepted, but you may want to review usage before the limit is reached.`;
  return {
    to: facts.recipientEmail,
    subject,
    text: [
      `Hello ${name},`,
      middle,
      `You are receiving this because you administer billing for this TManage organization. ` +
        `Manage storage from the billing area of your workspace settings.`,
    ].join('\n\n'),
  };
}

/** What became of one usage mail. `'none'` means no transport was configured to try. */
export type UsageThresholdMailDelivery = 'sent' | 'none' | 'failed';

/**
 * `CredentialChangeMailer`'s shape, for the usage-threshold crossing. {@link deliver} never
 * throws: it runs after the batch commits, where a throw could not un-publish the event, so the
 * error is absorbed into the operator's log — without the address, which the driver's words may
 * quote — and reported.
 */
export class UsageThresholdMailer {
  /** @param mailer `null` when no transport is wired — every database suite's default. */
  constructor(private readonly mailer: Mailer | null) {}

  /** Whether a transport exists to try; the consumer reads this before paying for the fan-out. */
  get enabled(): boolean {
    return this.mailer !== null;
  }

  /** The message this crossing would send, composed but not sent. Exposed for suites. */
  compose(facts: UsageThresholdEmailFacts): MailMessage {
    return composeUsageThresholdEmail(facts);
  }

  async deliver(facts: UsageThresholdEmailFacts): Promise<UsageThresholdMailDelivery> {
    if (this.mailer === null) return 'none';
    try {
      return await this.mailer.send(composeUsageThresholdEmail(facts));
    } catch (error) {
      // Absorbed loudly, without the address: the driver's words may name the recipient, so
      // they go to the operator's log and nowhere else — never into the batch report.
      console.error('[worker] usage threshold email failed', error);
      return 'failed';
    }
  }
}
