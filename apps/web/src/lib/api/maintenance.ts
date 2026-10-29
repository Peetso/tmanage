import type { ApiClient } from './client';

/**
 * Platform states (x185) — the public maintenance-window read.
 *
 * `GET /public/site/maintenance` is reachable with no session and no organization: the app shell
 * reads it to decide whether to show the maintenance / degraded-mode banner, before and independently
 * of any tenant. So the request declares `authentication: 'none'` — a 401 here would be about the
 * request, never a reason to refresh a session the reader may not have.
 *
 * The shapes below are paired Exact with the API's `MaintenanceWindowView` / `PublicMaintenanceView`
 * in `e2e/contracts/api-web-shapes.ts`; a field renamed on either side is a compile error there.
 */

/** The banner severities, the same closed vocabulary the API's `MAINTENANCE_SEVERITIES` declares. */
export type MaintenanceSeverity = 'info' | 'degraded' | 'down';

/** One maintenance window, as the banner renders it. */
export interface MaintenanceWindowView {
  readonly id: string;
  readonly message: string;
  readonly severity: MaintenanceSeverity;
  readonly startsAt: string;
  readonly endsAt: string;
  /** `true` when the window is currently running; the banner shows only an active window. */
  readonly active: boolean;
  // ---- platform-admin v2 · PA-10 ----
  /** The Arabic message (0244), when one was written. */
  readonly messageAr?: string;
}

/** The read's response: the current-or-next published window (or none), and the snapshot time. */
export interface PublicMaintenanceView {
  readonly window: MaintenanceWindowView | null;
  readonly asOf: string;
}

export async function fetchPublicMaintenance(client: ApiClient): Promise<PublicMaintenanceView> {
  const { data } = await client.request<PublicMaintenanceView>({
    path: '/public/site/maintenance',
    // No session is involved: the banner is read before any sign-in.
    authentication: 'none',
  });
  return data;
}

// ---- platform-admin v2 · PA-10 ----
// The operator's maintenance windows (`/v1/platform/maintenance`, SPEC §4 D4).

/** One window as the Maintenance mode page lists and edits it. */
export interface PlatformMaintenanceWindowView {
  readonly id: string;
  readonly message: string;
  readonly messageAr: string | null;
  readonly severity: MaintenanceSeverity;
  readonly startsAt: string;
  readonly endsAt: string;
  readonly published: boolean;
  readonly blockSignIn: boolean;
  readonly state: 'draft' | 'scheduled' | 'active' | 'ended';
  readonly endedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string | null;
}

export interface PlatformMaintenanceListView {
  readonly windows: readonly PlatformMaintenanceWindowView[];
  readonly current: PlatformMaintenanceWindowView | null;
  readonly asOf: string;
}

/** The editor body (a request-side shape). */
export interface MaintenanceWindowInput {
  readonly message: string;
  readonly messageAr: string | null;
  readonly severity: MaintenanceSeverity;
  readonly startsAt: string;
  readonly endsAt: string;
  readonly published: boolean;
  readonly blockSignIn: boolean;
  readonly reason?: string;
}

export const PLATFORM_MAINTENANCE_QUERY_KEY = ['platform', 'maintenance'] as const;

export async function fetchPlatformMaintenance(
  client: ApiClient,
): Promise<PlatformMaintenanceListView> {
  const { data } = await client.request<PlatformMaintenanceListView>({
    path: '/v1/platform/maintenance',
  });
  return data;
}

/** Create a window. The API needs a typed reason here (5–500 characters). */
export async function schedulePlatformMaintenance(
  client: ApiClient,
  input: MaintenanceWindowInput,
): Promise<MaintenanceWindowView> {
  const { data } = await client.request<MaintenanceWindowView>({
    method: 'POST',
    path: '/v1/platform/maintenance',
    body: input,
  });
  return data;
}

export async function updatePlatformMaintenance(
  client: ApiClient,
  id: string,
  input: Partial<MaintenanceWindowInput>,
): Promise<PlatformMaintenanceWindowView> {
  const { data } = await client.request<PlatformMaintenanceWindowView>({
    method: 'PATCH',
    path: `/v1/platform/maintenance/${encodeURIComponent(id)}`,
    body: input,
  });
  return data;
}

export async function unpublishPlatformMaintenance(
  client: ApiClient,
  id: string,
  reason: string,
): Promise<void> {
  await client.request<unknown>({
    method: 'POST',
    path: `/v1/platform/maintenance/${encodeURIComponent(id)}/unpublish`,
    body: { reason },
  });
}

export async function endPlatformMaintenance(
  client: ApiClient,
  id: string,
  reason?: string,
): Promise<PlatformMaintenanceWindowView> {
  const { data } = await client.request<PlatformMaintenanceWindowView>({
    method: 'POST',
    path: `/v1/platform/maintenance/${encodeURIComponent(id)}/end`,
    body: reason ? { reason } : {},
  });
  return data;
}
