import type { CampaignLanguage } from '@tmanage/mail';
import type { OutreachCampaignStatus } from '../../common/database/schema.js';
import type {
  CampaignCounts,
  CampaignRecord,
  RecipientSummary,
  SenderPool,
} from './outreach.repository.js';

/**
 * LANE-Q / OUTREACH MANAGER — what Platform admin -> Outreach shows of a campaign and of a
 * recipient. A recipient's address is never in a view (only in the audited export).
 */

export interface OutreachRecipientView {
  readonly id: string;
  readonly company: string;
  readonly personName: string;
  readonly firstName: string;
  readonly country: string;
  readonly language: string;
  readonly sender: string | null;
  readonly senderPersonId: string;
  readonly status: string;
  readonly sentAt: string | null;
  readonly lastError: string | null;
  readonly trialRedeemedAt: string | null;
  readonly walkthroughAt: string | null;
  readonly repliedAt: string | null;
  readonly followupStatus: string | null;
  readonly followupSentAt: string | null;
  readonly optedOut: boolean;
}

export interface OutreachCampaignView {
  readonly id: string;
  readonly name: string;
  readonly status: OutreachCampaignStatus;
  readonly languages: readonly CampaignLanguage[];
  readonly senderPool: SenderPool;
  readonly dailyCap: number;
  readonly warmup: boolean;
  readonly followupEnabled: boolean;
  readonly followupDays: number;
  readonly archivedAt: string | null;
  readonly firstStartedAt: string | null;
  readonly createdAt: string;
  readonly counts: Readonly<Record<string, number>>;
  readonly trialsRedeemed: number;
  readonly walkthroughs: number;
  readonly followupsSent: number;
  readonly replied: number;
  readonly optedOut: number;
}

export function campaignView(
  campaign: CampaignRecord,
  counts: CampaignCounts | undefined,
): OutreachCampaignView {
  return {
    id: campaign.id,
    name: campaign.name,
    status: campaign.status,
    languages: campaign.languages,
    senderPool: campaign.senderPool,
    dailyCap: campaign.dailyCap,
    warmup: campaign.warmup,
    followupEnabled: campaign.followupEnabled,
    followupDays: campaign.followupDays,
    archivedAt: campaign.archivedAt?.toISOString() ?? null,
    firstStartedAt: campaign.firstStartedAt?.toISOString() ?? null,
    createdAt: campaign.createdAt.toISOString(),
    counts: counts?.byStatus ?? {},
    trialsRedeemed: counts?.redeemed ?? 0,
    walkthroughs: counts?.walkthroughs ?? 0,
    followupsSent: counts?.followupsSent ?? 0,
    replied: counts?.replied ?? 0,
    optedOut: counts?.optedOut ?? 0,
  };
}

export function recipientView(r: RecipientSummary): OutreachRecipientView {
  return {
    id: r.id,
    company: r.company,
    personName: r.personName,
    firstName: r.firstName,
    country: r.country,
    language: r.language,
    sender: r.senderAddress,
    senderPersonId: r.senderPersonId,
    status: r.status,
    sentAt: r.sentAt?.toISOString() ?? null,
    lastError: r.lastError,
    trialRedeemedAt: r.trialRedeemedAt?.toISOString() ?? null,
    walkthroughAt: r.walkthroughAt?.toISOString() ?? null,
    repliedAt: r.repliedAt?.toISOString() ?? null,
    followupStatus: r.followupStatus,
    followupSentAt: r.followupSentAt?.toISOString() ?? null,
    optedOut: r.optedOut,
  };
}
