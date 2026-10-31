/**
 * Whether a person is using TManage right now. A live session refreshes its token every few
 * minutes while a tab is open, so a refresh inside this window means "online"; the account
 * being enabled says nothing about it.
 */
export const ONLINE_WINDOW_MS = 20 * 60 * 1000;

export function isOnlineNow(lastActiveAt: string | null | undefined, now = Date.now()): boolean {
  if (!lastActiveAt) return false;
  const at = new Date(lastActiveAt).getTime();
  return Number.isFinite(at) && now - at < ONLINE_WINDOW_MS;
}
