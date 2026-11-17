/**
 * Where sign-in returns to (ACC-01).
 *
 * A person who follows an invitation link while signed out is sent to sign-in; before this,
 * signing in always landed on `/organizations` and the invitation was lost. Only an invitation
 * path is ever honoured as a return target — anything else, including any absolute or
 * protocol-relative URL, falls back to `/organizations`, so `?next=` can never become an open
 * redirect.
 */

import { importToolFromSearch, withImportTool } from './import-link';

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

/**
 * CONFIRMPOLISH 2 — after an expired confirmation link: the workspace chooser, told to open the
 * person's Two-step sign-in settings, where "Send confirmation e-mail" lives. Exactly this value.
 */
export const CONFIRM_EMAIL_RETURN = '/organizations?then=confirm-email';

/** The `then` value of {@link CONFIRM_EMAIL_RETURN}. */
const THEN_CONFIRM_EMAIL = 'confirm-email';

/** Sign-in that comes back to the confirmation-mail setting (the expired link's button). */
export const SIGN_IN_TO_CONFIRM_EMAIL = `/sign-in?next=${encodeURIComponent(CONFIRM_EMAIL_RETURN)}`;

/** True when the chooser's query (`location.search`) asks for the confirmation-mail setting. */
export function wantsConfirmEmailSetting(search: string): boolean {
  try {
    return new URLSearchParams(search).get('then') === THEN_CONFIRM_EMAIL;
  } catch {
    return false;
  }
}

/** A workspace's Two-step sign-in settings, at the "Confirm your e-mail" section. */
export function confirmEmailSettingPath(organizationSlug: string): string {
  return `/${encodeURIComponent(organizationSlug)}/settings/two-step#tm-confirm-email`;
}

function isAllowedReturn(path: string): boolean {
  return (
    path === CONFIRM_EMAIL_RETURN ||
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

/**
 * 54-29: where sign-in goes. An allowed `?next=` wins; otherwise a "switch from X" visitor's
 * allow-listed `?import=<tool>` rides to the workspace chooser, which opens that workspace's
 * Import page. Anything else is the plain chooser.
 */
export function afterSignInPath(next: string | null | undefined, search = ''): string {
  const allowed = safeReturnPath(next);
  if (allowed !== DEFAULT_AFTER_SIGN_IN) return allowed;
  return withImportTool(DEFAULT_AFTER_SIGN_IN, importToolFromSearch(search));
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
