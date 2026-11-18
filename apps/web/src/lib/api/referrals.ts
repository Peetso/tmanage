import type { ApiClient } from './client';

/**
 * 57-08 REFERRAL — the owner's invite link (Settings › People › Invite agencies) and the Platform
 * admin's partner codes.
 *
 * The API decides everything: only the workspace owner gets an answer (403 otherwise); the list
 * holds the agencies that signed up — name and date, never an address or an "invited" count; the
 * reward is `null` while TManage is free in the beta.
 */

export type ReferralOutcome = 'counted' | 'self' | 'same_domain' | 'rate_limited';

export interface ReferralView {
  readonly code: string | null;
  readonly signedUp: number;
  readonly agencies: readonly { readonly name: string; readonly signedUpAt: string }[];
  readonly rewards: { readonly recorded: number } | null;
}

export interface PlatformPartnerView {
  readonly id: string;
  readonly name: string;
  readonly code: string;
  readonly createdAt: string;
  readonly counted: number;
  readonly signups: readonly {
    readonly name: string;
    readonly outcome: ReferralOutcome;
    readonly signedUpAt: string;
  }[];
}

export interface PlatformReferralsView {
  readonly workspaceTotals: Readonly<Record<ReferralOutcome, number>>;
  readonly partners: readonly PlatformPartnerView[];
}

/** The sign-up page reads the code from `?ref=`; only this shape is ever sent. */
const CODE_SHAPE = /^(?:p\.)?[a-z0-9](?:[a-z0-9-]{0,24})-[a-z2-9]{6}$/u;

export function referralCodeFromQuery(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null;
  const value = raw.trim().toLowerCase();
  return value.length <= 40 && CODE_SHAPE.test(value) ? value : null;
}

/**
 * The invite link, built from the address this app is served from (never typed). `signUpPath` is
 * the sign-up page in the sharer's language (`referral-invite-link.ts` picks it); English by default.
 */
export function inviteLinkFor(origin: string, code: string, signUpPath = '/sign-up'): string {
  return `${origin.replace(/\/+$/u, '')}${signUpPath}?ref=${encodeURIComponent(code)}`;
}

function base(organizationSlug: string): string {
  return `/v1/organizations/${encodeURIComponent(organizationSlug)}/referral`;
}

export async function getReferral(
  client: ApiClient,
  organizationSlug: string,
): Promise<ReferralView> {
  const { data } = await client.request<ReferralView>({ path: base(organizationSlug) });
  return data;
}

export async function createReferralCode(
  client: ApiClient,
  organizationSlug: string,
): Promise<ReferralView> {
  const { data } = await client.request<ReferralView>({
    method: 'POST',
    path: `${base(organizationSlug)}/code`,
  });
  return data;
}

export async function fetchPlatformReferrals(client: ApiClient): Promise<PlatformReferralsView> {
  const { data } = await client.request<PlatformReferralsView>({ path: '/v1/platform/referrals' });
  return data;
}

export async function createPartnerCode(
  client: ApiClient,
  name: string,
): Promise<{ readonly id: string; readonly code: string }> {
  const { data } = await client.request<{ readonly id: string; readonly code: string }>({
    method: 'POST',
    path: '/v1/platform/referrals/partners',
    body: { name },
  });
  return data;
}
