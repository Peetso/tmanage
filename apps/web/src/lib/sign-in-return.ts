/**
 * Where sign-in returns to (ACC-01).
 *
 * A person who follows an invitation link while signed out is sent to sign-in; before this,
 * signing in always landed on `/organizations` and the invitation was lost. Only an invitation
 * path is ever honoured as a return target — anything else, including any absolute or
 * protocol-relative URL, falls back to `/organizations`, so `?next=` can never become an open
 * redirect.
 */

const INVITATION_PATH = /^\/invitations\/[A-Za-z0-9_-]{40,64}$/u;

/**
 * The AI-app consent page with its OAuth query (MCP connector S9). Same-origin path only: the
 * query may hold only URL-safe and percent-encoded characters, so it can never smuggle a scheme,
 * a host, a backslash or a fragment, and its length is capped.
 */
const CONSENT_PATH = /^\/connect\/authorize\?[A-Za-z0-9\-._~%&=+]{1,4000}$/u;

/**
 * The AI approve page (MCP connector S10): `/<org slug>/ai/approve/<uuid>`. An AI app's approval
 * link is opened from the chat, often signed out; sign-in brings the person back to it. Path only.
 */
const AI_APPROVE_PATH = /^\/[a-z0-9][a-z0-9-]{0,62}\/ai\/approve\/[0-9a-f-]{36}$/u;

/**
 * A Platform admin page (PLATFORMFIX): `/platform` and its sub-pages, path only, plain segments.
 * A signed-out visitor is sent to sign-in from there by the server, and comes back after.
 */
const PLATFORM_PATH = /^\/platform(?:\/[A-Za-z0-9_-]{1,64}){0,6}$/u;

function isAllowedReturn(path: string): boolean {
  return (
    INVITATION_PATH.test(path) ||
    CONSENT_PATH.test(path) ||
    AI_APPROVE_PATH.test(path) ||
    PLATFORM_PATH.test(path)
  );
}

export const DEFAULT_AFTER_SIGN_IN = '/organizations';

/** The path sign-in should go to next, from an untrusted `?next=` value. */
export function safeReturnPath(next: string | null | undefined): string {
  return typeof next === 'string' && isAllowedReturn(next) ? next : DEFAULT_AFTER_SIGN_IN;
}

/** The sign-in URL for a page whose session just ended: carries the page back only if allowed. */
export function signInPathFor(pathname: string | null | undefined, search = ''): string {
  if (typeof pathname !== 'string') return '/sign-in';
  const here = `${pathname}${search}`;
  if (isAllowedReturn(here)) return `/sign-in?next=${encodeURIComponent(here)}`;
  return INVITATION_PATH.test(pathname)
    ? `/sign-in?next=${encodeURIComponent(pathname)}`
    : '/sign-in';
}
