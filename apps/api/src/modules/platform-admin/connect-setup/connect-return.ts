/**
 * R38 · where a company-storage connect (Google Drive, OneDrive) lands after the provider.
 *
 * Started from the Storage screen it returns there; started from a Connected apps card it returns
 * to that card. The choice travels inside the signed flow cookie, so only these two screens of the
 * flow's own workspace are ever possible.
 */

/** The only non-default return: the Connected apps screen. */
export type ConnectReturnTo = 'connected_apps';

/** The `returnTo` the web sends on connect: absent, or `connected-apps`. */
export function parseConnectReturnTo(value: unknown): ConnectReturnTo | undefined | 'invalid' {
  if (value === undefined) return undefined;
  return value === 'connected-apps' ? 'connected_apps' : 'invalid';
}

/** A flow's stored `returnTo` is valid when absent or the one known value. */
export function isStoredReturnTo(value: unknown): value is ConnectReturnTo | undefined {
  return value === undefined || value === 'connected_apps';
}

/** The screen a storage connect returns to: Connected apps, or the Storage screen by default. */
export function storageReturnScreen(
  base: string,
  organizationSlug: string,
  returnTo: ConnectReturnTo | undefined,
): string {
  return returnTo === 'connected_apps'
    ? `${base}/${organizationSlug}/settings/connected-apps`
    : `${base}/${organizationSlug}/admin/storage`;
}
