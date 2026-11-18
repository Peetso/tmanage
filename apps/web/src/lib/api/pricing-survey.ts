import type { ApiClient } from './client';

/**
 * 57-17 WTP — the willingness-to-pay card on Home and its Platform admin list.
 *
 * The card asks the API whether to show; the API decides (owner/admin only, after 14 days, once
 * per person). The answer carries a band and an optional note; the person and the workspace are
 * the session's, never fields this client supplies.
 */

export type PricingBand = 'nothing' | 'under_5' | '5_9' | '10_15' | 'over_15';

export const PRICING_BAND_VALUES: readonly PricingBand[] = [
  'nothing',
  'under_5',
  '5_9',
  '10_15',
  'over_15',
];

/** The note's cap, in characters — the API refuses longer (400). */
export const PRICING_NOTE_MAX = 500;

export interface PricingSurveyView {
  readonly show: boolean;
}

export interface PricingSurveyResultView {
  readonly show: false;
  readonly outcome: 'answered' | 'skipped';
}

export interface PlatformPricingAnswerView {
  readonly organizationName: string | null;
  readonly outcome: 'answered' | 'skipped';
  readonly band: PricingBand | null;
  readonly note: string | null;
  readonly answeredAt: string;
}

export interface PlatformPricingSurveyView {
  readonly answered: number;
  readonly skipped: number;
  readonly byBand: readonly { readonly band: PricingBand; readonly count: number }[];
  readonly rows: readonly PlatformPricingAnswerView[];
}

function base(organizationSlug: string): string {
  return `/v1/organizations/${encodeURIComponent(organizationSlug)}/pricing-survey`;
}

export async function getPricingSurvey(
  client: ApiClient,
  organizationSlug: string,
): Promise<PricingSurveyView> {
  const { data } = await client.request<PricingSurveyView>({ path: base(organizationSlug) });
  return data;
}

export async function answerPricingSurvey(
  client: ApiClient,
  organizationSlug: string,
  answer: { readonly band: PricingBand; readonly note: string | null },
): Promise<PricingSurveyResultView> {
  const { data } = await client.request<PricingSurveyResultView>({
    method: 'POST',
    path: `${base(organizationSlug)}/answer`,
    body: answer,
  });
  return data;
}

export async function skipPricingSurvey(
  client: ApiClient,
  organizationSlug: string,
): Promise<PricingSurveyResultView> {
  const { data } = await client.request<PricingSurveyResultView>({
    method: 'POST',
    path: `${base(organizationSlug)}/skip`,
  });
  return data;
}

export async function fetchPlatformPricingSurvey(
  client: ApiClient,
): Promise<PlatformPricingSurveyView> {
  const { data } = await client.request<PlatformPricingSurveyView>({
    path: '/v1/platform/pricing-survey',
  });
  return data;
}
