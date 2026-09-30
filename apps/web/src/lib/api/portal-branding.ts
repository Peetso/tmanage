import type { ApiClient } from './client';

/**
 * SEC / Client portal branding (module 13, x323) — a studio sets one client organization's
 * client-facing theme (accent colour, welcome heading, welcome text), and the client portal reads it.
 *
 * The staff surface is behind `client_member.manage` on the server (`PUT`/`GET
 * …/portal/branding/{clientOrganizationId}`); a caller without it gets the ordinary 403 the shared
 * client turns into an error. The client-org scope is a path segment, resolved tenant-scoped before
 * authorize, so an unknown or cross-tenant scope is a 404. The tenant is the slug in the path resolved
 * against the caller's membership, and the author is the authenticated principal — never a value this
 * client supplies.
 *
 * Paired with the API projections (`PortalBrandingService.PortalBrandingView` /
 * `PortalBrandingClientView`) so the two shapes cannot drift.
 */

/** Accent-colour allowlist — a `#RGB` or `#RRGGBB` hex token, matching the server's `parseSaveBody`. */
export const ACCENT_COLOR_PATTERN = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

/** The full internal branding record — paired Exact with the API `PortalBrandingView`. */
export interface PortalBranding {
  readonly clientOrganizationId: string;
  readonly accentColor: string;
  readonly welcomeHeading: string | null;
  readonly welcomeText: string | null;
  /** Internal-only: who last saved the branding. Never on the client projection. */
  readonly updatedBy: string | null;
  readonly updatedAt: string | null;
}

/** The client projection — presentation fields only, paired with `PortalBrandingClientView`. */
export interface PortalBrandingClientView {
  readonly accentColor: string;
  readonly welcomeHeading: string | null;
  readonly welcomeText: string | null;
}

/** What the staff editor saves. The tenant, scope and author come from the path/context, not here. */
export interface SavePortalBrandingInput {
  readonly accentColor: string;
  readonly welcomeHeading: string | null;
  readonly welcomeText: string | null;
}

function brandingPath(organizationSlug: string, clientOrganizationId: string): string {
  return `/v1/organizations/${encodeURIComponent(organizationSlug)}/portal/branding/${encodeURIComponent(
    clientOrganizationId,
  )}`;
}

/** Read one client organization's branding — the internal record (`client_member.manage`). */
export async function getPortalBranding(
  client: ApiClient,
  organizationSlug: string,
  clientOrganizationId: string,
): Promise<PortalBranding> {
  const { data } = await client.request<PortalBranding>({
    path: brandingPath(organizationSlug, clientOrganizationId),
  });
  return data;
}

/** Save (create or replace) one client organization's branding. Idempotent upsert on the server. */
export async function savePortalBranding(
  client: ApiClient,
  organizationSlug: string,
  clientOrganizationId: string,
  input: SavePortalBrandingInput,
): Promise<PortalBranding> {
  const { data } = await client.request<PortalBranding>({
    method: 'PUT',
    path: brandingPath(organizationSlug, clientOrganizationId),
    body: input,
  });
  return data;
}

/** Read one client organization's client-facing branding projection (`client_projection.read`). */
export async function getPortalBrandingForClient(
  client: ApiClient,
  organizationSlug: string,
  clientOrganizationId: string,
): Promise<PortalBrandingClientView> {
  const { data } = await client.request<PortalBrandingClientView>({
    path: `/v1/organizations/${encodeURIComponent(organizationSlug)}/portal/branding/client/${encodeURIComponent(
      clientOrganizationId,
    )}`,
  });
  return data;
}
