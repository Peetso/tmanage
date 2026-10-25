import type { ApiClient } from './api/client';
import type { OrganizationSummary } from './api/organizations';
import { DEFAULT_AFTER_SIGN_IN, safeReturnPath } from './sign-in-return';

/**
 * Where a person who opens `/sign-in` while already signed in belongs (live check f30af1d0).
 *
 * A signed-in visit to the sign-in page was reported ending on "You do not have permission"
 * (/forbidden) instead of in the app. It now goes into the app:
 *
 * - an allowed `?next=` (invitation, AI-app consent, AI approval — `safeReturnPath`) wins;
 * - one organization: its home (`/<slug>/home`), or its portal for a client member;
 * - several: the organization picker (`/organizations`);
 * - none: `undefined` — the sign-in page stays, so "Sign in with a different account" from the
 *   picker's access-removed state still reaches a usable form instead of bouncing back.
 *
 * Every answer is a same-origin path built here: the slug is checked against the slug
 * characters before it is used, so it can never become `//host` or `/\host`.
 */

const SLUG = /^[a-z0-9][a-z0-9-]{0,62}$/u;

export function destinationForSignedIn(
  organizations: readonly OrganizationSummary[],
  next: string | null | undefined,
): string | undefined {
  const allowedNext = safeReturnPath(next);
  if (allowedNext !== DEFAULT_AFTER_SIGN_IN) return allowedNext;
  if (organizations.length === 0) return undefined;
  if (organizations.length > 1) return DEFAULT_AFTER_SIGN_IN;
  const only = organizations[0]!;
  if (!SLUG.test(only.slug)) return DEFAULT_AFTER_SIGN_IN;
  return only.audience === 'client' ? `/${only.slug}/portal` : `/${only.slug}/home`;
}

/**
 * Asks the API whether this browser already has a session, without the refresh-and-sign-out
 * recovery an ordinary read gets: a signed-out visitor's 401 here must not announce
 * "session ended" (that would navigate to `/sign-in` again and drop `?next=`). Any failure —
 * 401, a network error, a 5xx — answers "not signed in", so the page behaves exactly as before.
 */
export async function signedInDestination(
  client: ApiClient,
  next: string | null | undefined,
): Promise<string | undefined> {
  try {
    const { data } = await client.request<{ organizations: readonly OrganizationSummary[] }>({
      path: '/v1/organizations',
      authentication: 'none',
    });
    return destinationForSignedIn(data.organizations ?? [], next);
  } catch {
    return undefined;
  }
}
