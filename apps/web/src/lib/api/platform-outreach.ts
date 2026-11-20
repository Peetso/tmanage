import type { ApiClient } from './client';

/**
 * LANE-Q — Platform admin -> Settings -> Outreach (`/v1/platform/outreach…`): import the
 * decision-makers list, see who is queued, sent or excluded, and start, pause or stop a campaign.
 * Paired Exact with the API views in `e2e/contracts/api-web-shapes.ts`.
 */

export type OutreachCampaignStatus = 'paused' | 'running' | 'stopped';
export type OutreachAction = 'start' | 'pause' | 'stop';
export type OutreachExclusion =
  | 'consent_country'
  | 'us_without_postal_address'
  | 'unknown_country'
  | 'no_name'
  | 'bad_email'
  | 'flagged'
  | 'contact_type'
  | 'duplicate_address'
  | 'second_at_company';

export interface OutreachRecipientView {
  readonly id: string;
  readonly company: string;
  readonly firstName: string;
  readonly country: string;
  readonly language: string;
  readonly sender: string | null;
  readonly status: string;
  readonly sentAt: string | null;
  readonly trialRedeemedAt: string | null;
}

export interface OutreachCampaignView {
  readonly id: string;
  readonly name: string;
  readonly status: OutreachCampaignStatus;
  readonly firstStartedAt: string | null;
  readonly createdAt: string;
  readonly counts: Readonly<Record<string, number>>;
  readonly trialsRedeemed: number;
}

export interface OutreachView {
  readonly campaigns: readonly OutreachCampaignView[];
  readonly recipients: readonly OutreachRecipientView[];
  readonly postalAddressSet: boolean;
}

export interface OutreachImportView extends OutreachView {
  readonly imported: number;
  readonly rows: number;
  readonly excluded: Readonly<Partial<Record<OutreachExclusion, number>>>;
}

export const PLATFORM_OUTREACH_QUERY_KEY = ['platform', 'outreach'] as const;

export async function fetchOutreach(client: ApiClient): Promise<OutreachView> {
  const { data } = await client.request<OutreachView>({ path: '/v1/platform/outreach' });
  return data;
}

export async function importOutreach(
  client: ApiClient,
  input: { readonly csv: string; readonly name?: string },
): Promise<OutreachImportView> {
  const { data } = await client.request<OutreachImportView>({
    method: 'POST',
    path: '/v1/platform/outreach/import',
    body: input,
  });
  return data;
}

export async function moveOutreachCampaign(
  client: ApiClient,
  campaignId: string,
  action: OutreachAction,
): Promise<OutreachView> {
  const { data } = await client.request<OutreachView>({
    method: 'POST',
    path: `/v1/platform/outreach/campaigns/${encodeURIComponent(campaignId)}/${action}`,
  });
  return data;
}

export async function markOutreachBounced(
  client: ApiClient,
  recipientId: string,
): Promise<OutreachView> {
  const { data } = await client.request<OutreachView>({
    method: 'POST',
    path: `/v1/platform/outreach/recipients/${encodeURIComponent(recipientId)}/bounced`,
  });
  return data;
}
