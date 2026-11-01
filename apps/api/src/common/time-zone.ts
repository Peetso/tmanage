/**
 * Whether `value` is an IANA time zone name the runtime can compute in — R9, "time zone should be
 * all countries": every field that stores a zone accepts any real zone, never a short allow-list.
 *
 * Asked of `Intl` rather than a bundled list, so the server and the browser agree on what exists.
 * The shape check comes first because `Intl` also accepts bare offsets (`+03:00`), which are not
 * zones, and so that nothing longer than the 64-character columns ever reaches it.
 */
export const MAX_TIME_ZONE_LENGTH = 64;

export function isIanaTimeZone(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  if (value.length === 0 || value.length > MAX_TIME_ZONE_LENGTH) return false;
  if (!/^[A-Za-z][A-Za-z0-9_+\-/]*$/.test(value)) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}
