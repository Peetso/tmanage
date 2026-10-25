/**
 * D5 (Figma F5) — the numbers and small rules of the data-rights workflow, in one place.
 *
 * The grace period (30 days) and the link lifetime (7 days) are the numbers the approved design shows.
 * F5.md records them as placeholders until legal confirms them (33-LEGAL §7); changing them is an
 * edit here and nowhere else — the screens read both from the API.
 */
export const DELETION_GRACE_PERIOD_DAYS = 30;
export const EXPORT_LINK_DAYS = 7;

const DAY_MS = 24 * 60 * 60 * 1000;

export function addDays(from: Date, days: number): Date {
  return new Date(from.getTime() + days * DAY_MS);
}

/** Whole days left until `until`, rounded up, never below zero. */
export function daysLeft(now: Date, until: Date): number {
  return Math.max(0, Math.ceil((until.getTime() - now.getTime()) / DAY_MS));
}

/** An export's state as the screens show it: a `ready` archive past its link date is `expired`. */
export type PrivacyExportState = 'preparing' | 'ready' | 'failed' | 'expired';

export function exportStateOf(
  row: { readonly status: 'preparing' | 'ready' | 'failed'; readonly expiresAt: Date | null },
  now: Date,
): PrivacyExportState {
  if (
    row.status === 'ready' &&
    row.expiresAt !== null &&
    row.expiresAt.getTime() <= now.getTime()
  ) {
    return 'expired';
  }
  return row.status;
}

/** "Type Northstar Studio to confirm": the typed name, trimmed, must equal the company's name. */
export function confirmsCompanyName(typed: unknown, organizationName: string): boolean {
  return (
    typeof typed === 'string' && typed.trim() === organizationName.trim() && typed.trim() !== ''
  );
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Where an archive's bytes live: under the tenant's own prefix, like every upload key
 * (`tenant/{organization}/…`), so per-tenant inventory and cleanup find it. Both parts are checked to
 * be lowercase UUIDs before they are joined — a key is a path.
 */
export function privacyExportObjectKey(organizationId: string, exportId: string): string {
  if (!UUID.test(organizationId) || !UUID.test(exportId)) {
    throw new Error('privacy export key components must be lowercase UUIDs');
  }
  return `tenant/${organizationId}/privacy-export/${exportId}/archive.json.gz`;
}
