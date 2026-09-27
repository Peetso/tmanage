import type { ApiClient } from './client';

/**
 * The per-project client-portal settings endpoints — SEC / Client portal (module 13, x238), gated on
 * `project.manage`. Nested under a project: both paths name the project the settings belong to,
 * tenant-scoped by the API.
 *
 * This is the **internal** settings surface — the studio configures how the client portal presents
 * itself. It is distinct from the client-facing projection (`…/portal/projects/:id/portal-settings`,
 * behind `client_projection.read`), which carries the presentation fields only and never `updatedBy`.
 *
 * - **Read** `GET …/projects/:id/portal-settings` returns the current settings, or code-level defaults
 *   when the project has never been configured (so the form always has something to show).
 * - **Save** `PUT …/projects/:id/portal-settings` replaces the settings; the accent must be one of a
 *   fixed palette and the welcome message is bounded, or the API answers 400.
 *
 * Hand-written and paired with the API projection in the `e2e/contracts` shape check so the two shapes
 * cannot drift.
 */

/** The fixed accent palette the API accepts. Mirrors the API's `PORTAL_ACCENT_PALETTE`. */
export const PORTAL_ACCENT_PALETTE = [
  '#2563eb',
  '#7c3aed',
  '#db2777',
  '#dc2626',
  '#d97706',
  '#059669',
  '#0891b2',
  '#4b5563',
] as const;

/**
 * The internal settings record the GET/PUT route exchanges. Paired Exact with the API
 * `PortalSettingsView`. `updatedBy`/`updatedAt` are null until the project is first configured.
 */
export interface PortalSettingsView {
  readonly projectId: string;
  readonly welcomeMessage: string | null;
  readonly accentColor: string;
  readonly showTeam: boolean;
  readonly showTimeline: boolean;
  readonly updatedBy: string | null;
  /** An ISO-8601 instant, or null when never configured. */
  readonly updatedAt: string | null;
}

/** What a save sends. The tenant and the author are the API's to fill, never this body's. */
export interface SavePortalSettingsInput {
  readonly welcomeMessage: string | null;
  readonly accentColor: string;
  readonly showTeam: boolean;
  readonly showTimeline: boolean;
}

function path(organizationSlug: string, projectId: string): string {
  return `/v1/organizations/${encodeURIComponent(organizationSlug)}/projects/${encodeURIComponent(projectId)}/portal-settings`;
}

export async function getPortalSettings(
  client: ApiClient,
  organizationSlug: string,
  projectId: string,
): Promise<PortalSettingsView> {
  const { data } = await client.request<PortalSettingsView>({
    path: path(organizationSlug, projectId),
  });
  return data;
}

export async function updatePortalSettings(
  client: ApiClient,
  organizationSlug: string,
  projectId: string,
  input: SavePortalSettingsInput,
): Promise<PortalSettingsView> {
  const { data } = await client.request<PortalSettingsView>({
    method: 'PUT',
    path: path(organizationSlug, projectId),
    body: input,
  });
  return data;
}
