/**
 * The pending-approvals badge opens the AI panel straight on tab 2, "Your AI" (Fable 5.2 ruling
 * 2026-11-23: "Your AI" is the default tab when something is waiting and the panel was opened
 * from the approvals badge). The badge lives in the Control Center menu, where no panel is
 * mounted, so it links to Home with `?ai=your-ai`; the app shell's launcher takes the request once
 * and removes it from the address, so a reload or Back does not open the panel again.
 */

const PARAM = 'ai';
const YOUR_AI = 'your-ai';

export function yourAiHref(organizationSlug: string): string {
  return `/${encodeURIComponent(organizationSlug)}/home?${PARAM}=${YOUR_AI}`;
}

/** True once when the address asks for "Your AI"; the request is then removed from it. */
export function takeYourAiRequest(): boolean {
  if (typeof window === 'undefined') return false;
  const url = new URL(window.location.href);
  if (url.searchParams.get(PARAM) !== YOUR_AI) return false;
  url.searchParams.delete(PARAM);
  window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`);
  return true;
}
