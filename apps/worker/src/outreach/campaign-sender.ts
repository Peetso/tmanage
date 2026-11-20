import type { FieldCipher } from '@tmanage/domain/field-cipher';
import { signTrialLink } from '@tmanage/mail';
import type { Mailer } from '@tmanage/mail';
import { campaignLinks, composeCampaignIntro } from './campaign-mail.js';
import { dailyCap, inSendWindow, mailboxMaySend } from './campaign-pace.js';
import type { MailboxState } from './campaign-pace.js';

/**
 * LANE-Q — one pass of the outreach sender (scheduled job `campaign-sender`, PART.md IP-17: one
 * bounded pass that resolves a log line or `null`; it runs under the job's named sweep lock in
 * both hosts, AS-4 / W-9, and checks its schedule against database state inside the pass).
 *
 * Per pass, per sending mailbox, at most ONE introduction, and only when all of these hold:
 * - the recipient's campaign is `running` (start / pause / stop are the platform admin's);
 * - the mailbox is an active person of the registry (a switched-off person sends nothing: the
 *   resolver would otherwise fall back to hello@, which is not who the recipient was promised);
 * - the mailbox is under its day's cap (5 / 10 / 20 by campaign week, never above 20) and the
 *   last attempt from it is at least 8 h / cap ago (`campaign-pace.ts`);
 * - it is 09:00-17:00 in the recipient's country time zone;
 * - the address is not on the suppression list (unsubscribed) and has no live bounce: such a
 *   recipient is marked `suppressed` and never written to.
 *
 * The claim (`queued` -> `sending`) is taken before the send, so a pass that dies mid-send never
 * sends twice (at most once, by design for cold mail). A refused send is `failed` with a short
 * code, not retried in v1; there are no follow-ups in v1.
 */

export interface CampaignRecord {
  readonly id: string;
  readonly firstStartedAt: Date;
}

export interface QueuedRecipient {
  readonly id: string;
  readonly campaignId: string;
  readonly company: string;
  readonly firstName: string;
  readonly emailEnc: string;
  readonly emailHash: string;
  /** ISO 3166-1 alpha-2. */
  readonly country: string;
  readonly timeZone: string;
  readonly language: 'en' | 'ar';
  readonly senderPersonId: string;
}

export type MailboxStats = MailboxState;

export interface CampaignSender {
  readonly nameEn: string;
  readonly nameAr: string;
  readonly active: boolean;
}

export interface CampaignSenderStore {
  runningCampaigns(): Promise<readonly CampaignRecord[]>;
  /** Attempts per sending person since `since` (the rolling day). */
  mailboxStats(since: Date): Promise<ReadonlyMap<string, MailboxStats>>;
  queued(campaignIds: readonly string[], limit: number): Promise<readonly QueuedRecipient[]>;
  senders(personIds: readonly string[]): Promise<ReadonlyMap<string, CampaignSender>>;
  isSuppressed(emailHash: string): Promise<boolean>;
  /** `queued` -> `sending`, stamping `sent_at`; false when another pass took it. */
  claim(id: string, at: Date): Promise<boolean>;
  settle(
    id: string,
    from: 'queued' | 'sending',
    to: 'sent' | 'failed' | 'suppressed',
    at: Date,
    error?: string,
  ): Promise<void>;
}

export interface CampaignSenderDeps {
  readonly store: CampaignSenderStore;
  readonly cipher: FieldCipher;
  /** `deriveTrialLinkKey(SESSION_SECRET)`. */
  readonly trialKey: Buffer;
  readonly mailer: Mailer;
  readonly webPublicUrl: string;
  /** CAMPAIGN_POSTAL_ADDRESS, read per pass ('' = unset). */
  readonly postalAddress: () => string;
  readonly now?: () => Date;
  /** How many queued rows one pass looks at. */
  readonly scan?: number;
}

export interface CampaignPassResult {
  readonly sent: number;
  readonly failed: number;
  readonly suppressed: number;
}

export const CAMPAIGN_TICK_MS = 5 * 60_000;
const DAY_MS = 86_400_000;
const CIPHER_PURPOSE = 'outreach_email' as const;

/** A short, PII-free reason for `last_error` (VARCHAR(64)). */
function errorCode(error: unknown): string {
  const code = (error as { code?: unknown; responseCode?: unknown } | null) ?? {};
  const raw =
    typeof code.responseCode === 'number'
      ? `smtp_${String(code.responseCode)}`
      : typeof code.code === 'string'
        ? code.code
        : 'send_failed';
  return raw.replace(/[^A-Za-z0-9_.-]/gu, '_').slice(0, 64);
}

export async function runCampaignPass(deps: CampaignSenderDeps): Promise<CampaignPassResult> {
  const now = (deps.now ?? (() => new Date()))();
  const result = { sent: 0, failed: 0, suppressed: 0 };
  const campaigns = await deps.store.runningCampaigns();
  if (campaigns.length === 0) return result;
  const started = new Map(campaigns.map((c) => [c.id, c.firstStartedAt]));
  const queued = await deps.store.queued(
    campaigns.map((c) => c.id),
    deps.scan ?? 500,
  );
  if (queued.length === 0) return result;

  const byMailbox = new Map<string, QueuedRecipient[]>();
  for (const recipient of queued) {
    const list = byMailbox.get(recipient.senderPersonId) ?? [];
    list.push(recipient);
    byMailbox.set(recipient.senderPersonId, list);
  }
  const senders = await deps.store.senders([...byMailbox.keys()]);
  const stats = await deps.store.mailboxStats(new Date(now.getTime() - DAY_MS));
  const postal = deps.postalAddress().trim();

  for (const [personId, recipients] of byMailbox) {
    const sender = senders.get(personId);
    if (sender === undefined || !sender.active) continue;
    const state = stats.get(personId) ?? { attempts24h: 0, lastAttemptAt: null };
    for (const recipient of recipients) {
      const first = started.get(recipient.campaignId);
      if (first === undefined) continue;
      const cap = dailyCap(first, now);
      if (!mailboxMaySend(state, cap, now)) break;
      if (!inSendWindow(now, recipient.timeZone)) continue;
      // A US recipient needs the postal address (CAN-SPAM); without it they wait, unwritten.
      if (recipient.country === 'US' && postal === '') continue;
      if (await deps.store.isSuppressed(recipient.emailHash)) {
        await deps.store.settle(recipient.id, 'queued', 'suppressed', now);
        result.suppressed += 1;
        continue;
      }
      if (!(await deps.store.claim(recipient.id, now))) continue;
      let email: string;
      try {
        email = deps.cipher.decrypt(recipient.emailEnc, {
          purpose: CIPHER_PURPOSE,
          ownerId: recipient.id,
        });
      } catch {
        await deps.store.settle(recipient.id, 'sending', 'failed', now, 'unreadable_address');
        result.failed += 1;
        break;
      }
      const token = signTrialLink(
        deps.trialKey,
        { recipientId: recipient.id, email, company: recipient.company },
        now,
      );
      const links = campaignLinks(deps.webPublicUrl, recipient.language, token);
      const message = composeCampaignIntro({
        to: email,
        language: recipient.language,
        firstName: recipient.firstName,
        company: recipient.company,
        senderName: recipient.language === 'ar' ? sender.nameAr : sender.nameEn,
        senderPersonId: personId,
        country: recipient.country,
        postalAddress: postal,
        ...links,
      });
      try {
        await deps.mailer.send(message);
        await deps.store.settle(recipient.id, 'sending', 'sent', now);
        result.sent += 1;
      } catch (error) {
        await deps.store.settle(recipient.id, 'sending', 'failed', now, errorCode(error));
        result.failed += 1;
      }
      break;
    }
  }
  return result;
}
