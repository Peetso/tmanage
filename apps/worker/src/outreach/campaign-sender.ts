import type { FieldCipher } from '@tmanage/domain/field-cipher';
import { DEFAULT_CAMPAIGN_EMAILS, signTrialLink } from '@tmanage/mail';
import type { CampaignEmailKind, CampaignEmailText, CampaignLanguage, Mailer } from '@tmanage/mail';
import { campaignLinks, composeCampaignMail } from './campaign-mail.js';
import { campaignCap, inSendWindow, mailboxMaySend, workingDaysBetween } from './campaign-pace.js';
import type { MailboxState } from './campaign-pace.js';

/**
 * LANE-Q / OUTREACH MANAGER — one pass of the outreach sender (scheduled job `campaign-sender`,
 * PART.md IP-17: one bounded pass that resolves a log line or `null`; it runs under the job's
 * named sweep lock in both hosts, AS-4 / W-9, and checks its schedule against database state
 * inside the pass).
 *
 * Per pass, per sending mailbox, at most ONE mail (an introduction first, else one follow-up),
 * and only when all of these hold:
 * - the recipient's campaign is `running` and not archived (the platform admin's controls);
 * - the mailbox is an active person of the registry (a switched-off person sends nothing: the
 *   resolver would otherwise fall back to hello@, which is not who the recipient was promised),
 *   and, for a campaign with chosen senders, one of them;
 * - the mailbox is under the campaign's day cap (`campaignCap`: its own cap 1-20, ramped 5 / 10
 *   while warm-up is on, never above 20), counted over introductions AND follow-ups, and the last
 *   attempt from it is at least 8 h / cap ago (`campaign-pace.ts`);
 * - it is 09:00-17:00 in the recipient's country time zone;
 * - the address is not on the suppression list (unsubscribed) and has no live bounce: such a
 *   recipient is marked `suppressed` (or its follow-up `skipped`) and never written to.
 *
 * The text is the campaign's newest saved version in the recipient's language, else its English
 * version, else the default text; the version used is stamped on the row (`intro_version`,
 * `followup_version`), so what went out is always known. The follow-up (one, off by default) is
 * due `followup_days` working days after the introduction, and never after a reply, a trial or a
 * walkthrough booking.
 *
 * The claim (`queued` -> `sending`, follow-up NULL -> `sending`) is taken before the send, so a
 * pass that dies mid-send never sends twice (at most once, by design for cold mail). A refused
 * send is `failed` with a short code, not retried.
 */

export interface CampaignRecord {
  readonly id: string;
  readonly firstStartedAt: Date;
  /** 1-20 per mailbox per day. */
  readonly dailyCap: number;
  readonly warmup: boolean;
  readonly followupEnabled: boolean;
  /** Working days between the introduction and the follow-up. */
  readonly followupDays: number;
  readonly senderPool: 'auto' | 'chosen';
}

/** The newest saved text of one campaign, kind and language. */
export interface CampaignVersion {
  readonly campaignId: string;
  readonly kind: CampaignEmailKind;
  readonly language: CampaignLanguage;
  readonly version: number;
  readonly text: CampaignEmailText;
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
  readonly language: CampaignLanguage;
  readonly senderPersonId: string;
}

/** A sent recipient that may be due its follow-up. */
export interface FollowupCandidate extends QueuedRecipient {
  readonly sentAt: Date;
}

export type MailboxStats = MailboxState;

export interface CampaignSender {
  readonly nameEn: string;
  readonly nameAr: string;
  readonly active: boolean;
}

export interface CampaignSenderStore {
  runningCampaigns(): Promise<readonly CampaignRecord[]>;
  /** The newest version per (campaign, kind, language) of these campaigns. */
  versions(campaignIds: readonly string[]): Promise<readonly CampaignVersion[]>;
  /** The chosen senders per campaign (only campaigns with `sender_pool = 'chosen'` are asked). */
  chosenSenders(campaignIds: readonly string[]): Promise<ReadonlyMap<string, ReadonlySet<string>>>;
  /** Attempts per sending person since `since` (the rolling day; introductions + follow-ups). */
  mailboxStats(since: Date): Promise<ReadonlyMap<string, MailboxStats>>;
  queued(campaignIds: readonly string[], limit: number): Promise<readonly QueuedRecipient[]>;
  /** Sent, follow-up not yet tried, no reply, trial or booking; oldest first. */
  followupCandidates(
    campaignIds: readonly string[],
    limit: number,
  ): Promise<readonly FollowupCandidate[]>;
  senders(personIds: readonly string[]): Promise<ReadonlyMap<string, CampaignSender>>;
  isSuppressed(emailHash: string): Promise<boolean>;
  /** `queued` -> `sending`, stamping `sent_at` and `intro_version`; false when another pass took it. */
  claim(id: string, at: Date, version: number | null): Promise<boolean>;
  settle(
    id: string,
    from: 'queued' | 'sending',
    to: 'sent' | 'failed' | 'suppressed',
    at: Date,
    error?: string,
  ): Promise<void>;
  /** Follow-up NULL -> `sending`, stamping `followup_sent_at` and `followup_version`. */
  claimFollowup(id: string, at: Date, version: number | null): Promise<boolean>;
  settleFollowup(
    id: string,
    from: null | 'sending',
    to: 'sent' | 'failed' | 'skipped',
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
  /** How many queued rows (and, separately, follow-up candidates) one pass looks at. */
  readonly scan?: number;
}

export interface CampaignPassResult {
  readonly sent: number;
  readonly failed: number;
  readonly suppressed: number;
  readonly followupsSent: number;
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

interface ResolvedText {
  readonly text: CampaignEmailText;
  /** The language the text is written in (its unsubscribe line follows it). */
  readonly language: CampaignLanguage;
  /** The saved version used, or `null` for the default text. */
  readonly version: number | null;
}

const versionKey = (campaignId: string, kind: CampaignEmailKind, language: string): string =>
  `${campaignId}|${kind}|${language}`;

/** The recipient's language version, else English, else the default text; `null` when none. */
export function resolveCampaignText(
  versions: ReadonlyMap<string, CampaignVersion>,
  campaignId: string,
  kind: CampaignEmailKind,
  language: CampaignLanguage,
): ResolvedText | null {
  for (const lang of language === 'en' ? ['en' as const] : [language, 'en' as const]) {
    const saved = versions.get(versionKey(campaignId, kind, lang));
    if (saved !== undefined) return { text: saved.text, language: lang, version: saved.version };
  }
  for (const lang of language === 'ar' ? ['ar' as const, 'en' as const] : ['en' as const]) {
    const fallback = DEFAULT_CAMPAIGN_EMAILS[kind][lang];
    if (fallback !== undefined) return { text: fallback, language: lang, version: null };
  }
  return null;
}

interface Job {
  readonly kind: CampaignEmailKind;
  readonly recipient: QueuedRecipient;
}

export async function runCampaignPass(deps: CampaignSenderDeps): Promise<CampaignPassResult> {
  const now = (deps.now ?? (() => new Date()))();
  const result = { sent: 0, failed: 0, suppressed: 0, followupsSent: 0 };
  const campaigns = await deps.store.runningCampaigns();
  if (campaigns.length === 0) return result;
  const byId = new Map(campaigns.map((c) => [c.id, c]));
  const scan = deps.scan ?? 500;
  const queued = await deps.store.queued(
    campaigns.map((c) => c.id),
    scan,
  );
  const followupCampaigns = campaigns.filter((c) => c.followupEnabled).map((c) => c.id);
  const candidates =
    followupCampaigns.length === 0
      ? []
      : await deps.store.followupCandidates(followupCampaigns, scan);
  const due = candidates.filter((r) => {
    const campaign = byId.get(r.campaignId);
    if (campaign === undefined) return false;
    const days = workingDaysBetween(r.sentAt, now, r.timeZone);
    return days !== null && days >= campaign.followupDays;
  });
  if (queued.length === 0 && due.length === 0) return result;

  // Introductions first, then follow-ups, per mailbox.
  const byMailbox = new Map<string, Job[]>();
  const add = (kind: CampaignEmailKind, recipient: QueuedRecipient) => {
    const list = byMailbox.get(recipient.senderPersonId) ?? [];
    list.push({ kind, recipient });
    byMailbox.set(recipient.senderPersonId, list);
  };
  for (const recipient of queued) add('intro', recipient);
  for (const recipient of due) add('followup', recipient);

  const campaignIds = [
    ...new Set([...byMailbox.values()].flat().map((j) => j.recipient.campaignId)),
  ];
  const chosenIds = campaignIds.filter((id) => byId.get(id)?.senderPool === 'chosen');
  const [senders, stats, savedVersions, chosen] = await Promise.all([
    deps.store.senders([...byMailbox.keys()]),
    deps.store.mailboxStats(new Date(now.getTime() - DAY_MS)),
    deps.store.versions(campaignIds),
    chosenIds.length === 0
      ? Promise.resolve(new Map<string, ReadonlySet<string>>())
      : deps.store.chosenSenders(chosenIds),
  ]);
  const versions = new Map(
    savedVersions.map((v) => [versionKey(v.campaignId, v.kind, v.language), v]),
  );
  const postal = deps.postalAddress().trim();

  for (const [personId, jobs] of byMailbox) {
    const sender = senders.get(personId);
    if (sender === undefined || !sender.active) continue;
    const state = stats.get(personId) ?? { attempts24h: 0, lastAttemptAt: null };
    for (const { kind, recipient } of jobs) {
      const campaign = byId.get(recipient.campaignId);
      if (campaign === undefined) continue;
      if (campaign.senderPool === 'chosen' && chosen.get(campaign.id)?.has(personId) !== true) {
        continue;
      }
      if (!mailboxMaySend(state, campaignCap(campaign, now), now)) continue;
      if (!inSendWindow(now, recipient.timeZone)) continue;
      // A US recipient needs the postal address (CAN-SPAM); without it they wait, unwritten.
      if (recipient.country === 'US' && postal === '') continue;
      if (await deps.store.isSuppressed(recipient.emailHash)) {
        if (kind === 'intro') {
          await deps.store.settle(recipient.id, 'queued', 'suppressed', now);
          result.suppressed += 1;
        } else {
          await deps.store.settleFollowup(recipient.id, null, 'skipped', now, 'suppressed');
        }
        continue;
      }
      const resolved = resolveCampaignText(versions, campaign.id, kind, recipient.language);
      if (resolved === null) {
        if (kind === 'intro') {
          await deps.store.settle(recipient.id, 'queued', 'failed', now, 'no_text');
          result.failed += 1;
        } else {
          await deps.store.settleFollowup(recipient.id, null, 'failed', now, 'no_text');
        }
        continue;
      }
      const claimed =
        kind === 'intro'
          ? await deps.store.claim(recipient.id, now, resolved.version)
          : await deps.store.claimFollowup(recipient.id, now, resolved.version);
      if (!claimed) continue;
      const fail = async (code: string) => {
        if (kind === 'intro') await deps.store.settle(recipient.id, 'sending', 'failed', now, code);
        else await deps.store.settleFollowup(recipient.id, 'sending', 'failed', now, code);
        result.failed += 1;
      };
      let email: string;
      try {
        email = deps.cipher.decrypt(recipient.emailEnc, {
          purpose: CIPHER_PURPOSE,
          ownerId: recipient.id,
        });
      } catch {
        await fail('unreadable_address');
        break;
      }
      const token = signTrialLink(
        deps.trialKey,
        { recipientId: recipient.id, email, company: recipient.company },
        now,
      );
      const links = campaignLinks(deps.webPublicUrl, resolved.language, token);
      const message = composeCampaignMail(
        {
          to: email,
          language: resolved.language,
          firstName: recipient.firstName,
          company: recipient.company,
          senderName: resolved.language === 'ar' ? sender.nameAr : sender.nameEn,
          senderPersonId: personId,
          country: recipient.country,
          postalAddress: postal,
          ...links,
        },
        { kind, text: resolved.text },
      );
      try {
        await deps.mailer.send(message);
        if (kind === 'intro') {
          await deps.store.settle(recipient.id, 'sending', 'sent', now);
          result.sent += 1;
        } else {
          await deps.store.settleFollowup(recipient.id, 'sending', 'sent', now);
          result.followupsSent += 1;
        }
      } catch (error) {
        await fail(errorCode(error));
      }
      break;
    }
  }
  return result;
}
