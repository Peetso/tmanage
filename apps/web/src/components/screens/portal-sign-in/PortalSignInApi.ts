import type { ApiClient } from '../../../lib/api/client';

/**
 * 55-14 — the client portal's e-mail-link sign-in, `/v1/public/portal-sign-in…`, no session in.
 * Shapes mirror the API's `MagicLinkPreview` and `PortalSignedInView`.
 */

export type MagicLinkPreview =
  | { readonly state: 'expired' | 'revoked' }
  | {
      readonly state: 'active';
      readonly organizationName: string;
      readonly organizationSlug: string;
      readonly audienceHint: string | null;
      readonly expiresAt: string;
    };

export interface PortalSignedIn {
  readonly status: 'authenticated';
  readonly csrfToken: string;
  readonly expiresAt: string;
}

const BASE = '/v1/public/portal-sign-in';

function linkPath(token: string): string {
  return `${BASE}/links/${encodeURIComponent(token)}`;
}

export async function requestMagicLink(
  client: ApiClient,
  body: { readonly orgSlug: string; readonly email: string; readonly language: 'en' | 'ar' },
): Promise<void> {
  await client.request<unknown>({ method: 'POST', path: BASE, body, authentication: 'none' });
}

export async function previewMagicLink(
  client: ApiClient,
  token: string,
): Promise<MagicLinkPreview> {
  const { data } = await client.request<MagicLinkPreview>({
    path: linkPath(token),
    authentication: 'none',
  });
  return data;
}

export async function consumeMagicLink(client: ApiClient, token: string): Promise<PortalSignedIn> {
  const { data } = await client.request<PortalSignedIn>({
    method: 'POST',
    path: `${linkPath(token)}/consume`,
    body: {},
    authentication: 'none',
  });
  client.rememberCsrfToken(data.csrfToken);
  return data;
}

export async function cancelMagicLink(client: ApiClient, token: string): Promise<void> {
  await client.request<unknown>({
    method: 'POST',
    path: `${linkPath(token)}/not-you`,
    body: {},
    authentication: 'none',
  });
}

export async function signInWithMagicCode(
  client: ApiClient,
  body: { readonly orgSlug: string; readonly email: string; readonly code: string },
): Promise<PortalSignedIn> {
  const { data } = await client.request<PortalSignedIn>({
    method: 'POST',
    path: `${BASE}/code`,
    body,
    authentication: 'none',
  });
  client.rememberCsrfToken(data.csrfToken);
  return data;
}
