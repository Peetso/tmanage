import type { ApiClient } from './client';

/**
 * The consent page's endpoints (MCP connector S9), behind `/connect/authorize`.
 *
 * The authorize parameters come from the page's own URL (where `/oauth/authorize` put them after
 * validating) and are sent back verbatim on every call; the API re-validates them each time and
 * trusts none of them. The approval carries the ticket the view returned — bound to this session
 * and these parameters — and answers with the URL to send the browser to, which the page follows
 * with `location.assign` (a form POST that 302s to another origin is blocked by `form-action`).
 */

/** The OAuth parameters the page carries. Only these are forwarded; anything else is dropped. */
export const CONSENT_PARAM_NAMES = [
  'client_id',
  'redirect_uri',
  'code_challenge',
  'code_challenge_method',
  'resource',
  'scope',
  'state',
] as const;

export type ConsentParams = Partial<Record<(typeof CONSENT_PARAM_NAMES)[number], string>>;

export interface ConsentClient {
  readonly name: string;
  readonly verified: boolean;
  readonly publisher: string | null;
  readonly redirectHost: string;
  readonly loopback: boolean;
}

export interface ConsentView {
  readonly client: ConsentClient;
  readonly requestedScopes: readonly string[];
  /**
   * ADR-0015 F11: the platform admin scope. `offered` only to a platform admin; `ready` once two-step
   * is on and they stepped up in Platform admin minutes ago. Off by default either way.
   */
  readonly platform?: { readonly offered: boolean; readonly ready: boolean };
  readonly ticket: string;
}

/** Pick the known OAuth parameters out of a query string. */
export function consentParamsFrom(search: URLSearchParams): ConsentParams {
  const params: Record<string, string> = {};
  for (const name of CONSENT_PARAM_NAMES) {
    const value = search.get(name);
    if (value !== null) params[name] = value;
  }
  return params;
}

export async function loadConsent(client: ApiClient, params: ConsentParams): Promise<ConsentView> {
  const query = new URLSearchParams(params as Record<string, string>).toString();
  const { data } = await client.request<ConsentView>({ path: `/v1/oauth/consent?${query}` });
  return data;
}

export async function approveConsent(
  client: ApiClient,
  organizationSlug: string,
  input: { readonly params: ConsentParams; readonly ticket: string; readonly scopes: string[] },
): Promise<string> {
  const { data } = await client.request<{ redirectUrl: string }>({
    method: 'POST',
    path: `/v1/organizations/${encodeURIComponent(organizationSlug)}/oauth/consent`,
    body: { ...input.params, ticket: input.ticket, scopes: input.scopes },
  });
  return data.redirectUrl;
}

export async function denyConsent(client: ApiClient, params: ConsentParams): Promise<string> {
  const { data } = await client.request<{ redirectUrl: string }>({
    method: 'POST',
    path: '/v1/oauth/consent/deny',
    body: params,
  });
  return data.redirectUrl;
}
