/**
 * The tab remembers which Support session it entered each organization with, so the ended page
 * (437:18974) can still name it after the organization's own read stops returning it. Session
 * storage only: a new tab starts clean, and a blocked storage just means no ended page.
 */
const PREFIX = 'tm.supportSession.';

export function supportSessionQueryKey(sessionId: string) {
  return ['support', 'session', sessionId] as const;
}

export function rememberSupportSession(organizationSlug: string, sessionId: string): void {
  try {
    window.sessionStorage.setItem(`${PREFIX}${organizationSlug}`, sessionId);
  } catch {
    // Storage blocked: the banner still works, only the ended page is skipped.
  }
}

export function rememberedSupportSession(organizationSlug: string): string | null {
  try {
    return window.sessionStorage.getItem(`${PREFIX}${organizationSlug}`);
  } catch {
    return null;
  }
}

export function forgetSupportSession(organizationSlug: string): void {
  try {
    window.sessionStorage.removeItem(`${PREFIX}${organizationSlug}`);
  } catch {
    // Nothing to forget.
  }
}
