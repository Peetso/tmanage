/**
 * The API closes whole calendar months only (`parseLockWindow` in `time/locks-rules.ts`): the start
 * is the first of a month and the end its last day. A `YYYY-MM` from a month picker becomes that
 * window here, so the screen never sends a window the API would refuse. `null` for anything else.
 */
export function monthWindow(
  month: string,
): { readonly periodStart: string; readonly periodEnd: string } | null {
  const match = /^(\d{4})-(\d{2})$/u.exec(month.trim());
  if (match === null) return null;
  const year = Number(match[1]);
  const monthIndex = Number(match[2]);
  if (monthIndex < 1 || monthIndex > 12) return null;
  const lastDay = new Date(Date.UTC(year, monthIndex, 0)).getUTCDate();
  const mm = String(monthIndex).padStart(2, '0');
  return {
    periodStart: `${match[1]}-${mm}-01`,
    periodEnd: `${match[1]}-${mm}-${String(lastDay).padStart(2, '0')}`,
  };
}

/** The API's reopen reason bounds (`UNLOCK_REASON_MIN`/`MAX`), checked before the request. */
export const REOPEN_REASON_MIN = 3;
export const REOPEN_REASON_MAX = 500;

export function isReopenReasonValid(reason: string): boolean {
  const length = reason.trim().length;
  return length >= REOPEN_REASON_MIN && length <= REOPEN_REASON_MAX;
}
