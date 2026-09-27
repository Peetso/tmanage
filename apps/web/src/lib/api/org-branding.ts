import type { ApiClient } from './client';

/**
 * The org-wide branding endpoints — ADM / org identity (Administration, module 18, x327). Org-wide
 * branding for the *internal* app chrome: the display product name, an accent colour, and a short logo
 * text / initials. Text and colour only — no file upload this slice. One row per organization.
 *
 * - **Read** `GET …/branding` returns the current branding, or code-level defaults when the studio has
 *   never configured it (so the shell always has something to render). Behind `work.read` — any
 *   authenticated member resolves the chrome.
 * - **Save** `PUT …/admin/branding` replaces the branding; the accent must be a hex colour
 *   (`#RGB`/`#RRGGBB`) and the product name / logo text are bounded, or the API answers 400. Behind
 *   `org.manage` — only an admin sets it.
 *
 * Distinct from the per-project client-portal settings (`portal-settings.ts`, client-facing) and from
 * behaviour-flag org settings. Hand-written and paired with the API projection so the two shapes cannot
 * drift.
 */

/** The accent-colour allowlist the API accepts, mirroring the API's `ORG_BRANDING_ACCENT_PATTERN`. */
export const ORG_BRANDING_ACCENT_PATTERN = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

/**
 * The branding record the GET/PUT routes exchange. Paired Exact with the API `OrgBrandingView`.
 * `updatedBy`/`updatedAt` are null until the studio first configures its branding.
 */
export interface OrgBrandingView {
  readonly productName: string | null;
  readonly accentColor: string;
  readonly logoText: string | null;
  readonly updatedBy: string | null;
  /** An ISO-8601 instant, or null when never configured. */
  readonly updatedAt: string | null;
}

/** What a save sends. The tenant and the author are the API's to fill, never this body's. */
export interface SaveOrgBrandingInput {
  readonly productName: string | null;
  readonly accentColor: string;
  readonly logoText: string | null;
}

function readPath(organizationSlug: string): string {
  return `/v1/organizations/${encodeURIComponent(organizationSlug)}/branding`;
}

function savePath(organizationSlug: string): string {
  return `/v1/organizations/${encodeURIComponent(organizationSlug)}/admin/branding`;
}

export async function getOrgBranding(
  client: ApiClient,
  organizationSlug: string,
): Promise<OrgBrandingView> {
  const { data } = await client.request<OrgBrandingView>({ path: readPath(organizationSlug) });
  return data;
}

export async function updateOrgBranding(
  client: ApiClient,
  organizationSlug: string,
  input: SaveOrgBrandingInput,
): Promise<OrgBrandingView> {
  const { data } = await client.request<OrgBrandingView>({
    method: 'PUT',
    path: savePath(organizationSlug),
    body: input,
  });
  return data;
}
