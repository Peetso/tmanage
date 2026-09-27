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
