import { signInPathFor } from './sign-in-return';

/**
 * PLATFORMFIX (live 2026-11-16): a signed-out visitor to `/platform` saw the Platform admin shell
 * and its menu for seconds before the browser was sent to sign-in. The signed-in areas that are
 * not a workspace address are now answered by the server before any of their HTML is sent: with
 * no session, a 307 to sign-in (the Platform admin page comes back after sign-in; the others
 * land on the default). Who may see Platform admin once signed in is the API's answer, asked by
 * the production server (`apps/server/platform-gate.mjs`) before the page renders.
 *
 * `hasSession` is the routing hint of `sessionHint`; a forged cookie only reaches the server-side
 * membership check, never the shell.
 */
const SIGNED_IN_AREAS = ['/platform', '/organizations', '/sessions', '/onboarding'] as const;

/** True for `/platform`, `/platform/...` and the other signed-in areas (exact segment match). */
export function isSignedInArea(pathname: string): boolean {
  return SIGNED_IN_AREAS.some((area) => pathname === area || pathname.startsWith(`${area}/`));
}

/** The sign-in address a signed-out request for a signed-in area goes to, or `undefined`. */
export function signedOutAreaRedirect(pathname: string, hasSession: boolean): string | undefined {
  if (hasSession || !isSignedInArea(pathname)) return undefined;
  return signInPathFor(pathname);
}
