import type { ApiClient } from './client';

/**
 * AI credits of the workspace (plan 62 §5, slices 62-07 and 62-18): `GET …/ai/credits`
 * (`billing.view`) and "Get more credits" `POST …/ai/credits/pack-requests` (`billing.manage`,
 * 409 `conflict` while a request is open). Both are 404 for a workspace without TManage AI.
 * Mirrors `AiCreditsView` in `apps/api/src/modules/billing/ai-packs.service.ts`.
 */

export type AiAllowanceSource = 'plan' | 'agreement' | 'support' | 'platform';

export interface AiCreditPackView {
  readonly remainingCredits: number;
  readonly grantedAt: string;
  readonly expiresAt: string;
}

export interface AiPackRequestView {
  readonly id: string;
  readonly status: 'open' | 'granted' | 'declined';
  readonly requestedAt: string;
}

export interface AiCreditsView {
  readonly periodStart: string;
  readonly resetsOn: string;
  readonly allowanceCredits: number;
  readonly limitedBy: AiAllowanceSource;
  readonly raisedBySupport: boolean;
  readonly packCreditsThisMonth: number;
  readonly usedCredits: number;
  readonly heldCredits: number;
  readonly remainingCredits: number;
  readonly packBalanceCredits: number;
  readonly packs: readonly AiCreditPackView[];
  readonly memberShareCredits: number;
  readonly openRequest: AiPackRequestView | null;
  readonly canRequestPack: boolean;
}

const base = (slug: string) => `/v1/organizations/${encodeURIComponent(slug)}/ai/credits`;

export async function fetchAiCredits(
  client: ApiClient,
  organizationSlug: string,
): Promise<AiCreditsView> {
  const { data } = await client.request<AiCreditsView>({ path: base(organizationSlug) });
  return data;
}

export async function requestAiPack(
  client: ApiClient,
  organizationSlug: string,
): Promise<AiPackRequestView> {
  const { data } = await client.request<AiPackRequestView>({
    method: 'POST',
    path: `${base(organizationSlug)}/pack-requests`,
  });
  return data;
}

/** The meter's tone, from the Figma Meter rules: low from 80 %, full at 100 %. */
export function creditsTone(used: number, total: number): 'default' | 'low' | 'full' {
  if (total <= 0) return 'full';
  const share = used / total;
  if (share >= 1) return 'full';
  if (share >= 0.8) return 'low';
  return 'default';
}
