import { REFRESH_PATH, type ApiClient } from './client';
import { clearAllDraftBackups } from '../../components/docs/editor/unsaved-draft';
import type { SessionIntelView } from './session-intel';

/**
 * The session endpoints, as the screens use them.
 *
 * These mirror `apps/api/src/modules/identity/session.controller.ts`. The shapes are
 * hand-written for the boundary reason given in `errors.ts` and are replaced when
 * `packages/contracts` is generated.
 *
 * Every helper that receives a `csrfToken` hands it to the client (`rememberCsrfToken`), so
 * the token the API returned to this tab is the one this tab echoes — see `client.ts` on why
 * that matters when the cookie is not readable (review finding D03).
 */

export interface EstablishedSession {
  readonly csrfToken: string;
  readonly expiresAt: string;
}

/**
 * One row of the sessions-and-devices list. Carries no credential material by design.
 *
 * The dates arrive as ISO strings rather than the `Date` objects the API's repository type
 * declares, because JSON has no date type. This is exactly the sort of drift a generated
 * `packages/contracts` removes; until it exists the difference is stated here rather than
 * discovered at runtime.
 *
 * There is no `current` flag. The API does not send one — `SessionSummary` in
 * `sessions.repository.ts` has five fields and that is not among them — so the screen cannot
 * mark "this device" yet. That gap is recorded in `docs/implementation-status.md` rather
 * than papered over by guessing from the user agent.
 */
export interface SessionSummary {
  readonly id: string;
  readonly userAgent: string | null;
  readonly createdAt: string;
  readonly rotatedAt: string | null;
  readonly expiresAt: string;
  /** R12: where the session came from. */
  readonly intel: SessionIntelView;
}

/** R12: the absolute URL of one of the caller's own sessions' sign-in trail CSV. */
export function mySessionTrailCsvUrl(baseUrl: string, sessionId: string): string {
  return `${baseUrl}/v1/me/sessions/${encodeURIComponent(sessionId)}/trail.csv`;
}

/**
 * The **development-only** sign-in.
 *
 * ID-002 — passwords, passkeys, MFA, SSO — is not written. Nothing in this system
 * authenticates a person yet: this route takes a user id on trust, and it is named
 * `developmentSignIn` here, mounted at `/v1/dev/sessions` in the API, and registered only
 * when `NODE_ENV !== 'production'`, so that no reader and no build mistakes it for
 * authentication.
 *
 * The sign-in screen calls it behind a clearly labelled development panel. That is the
 * honest arrangement: the screen is real, the credential check is visibly absent, and
 * nothing pretends otherwise.
 */
export async function developmentSignIn(
  client: ApiClient,
  userId: string,
): Promise<EstablishedSession> {
  const { data } = await client.request<EstablishedSession>({
    method: 'POST',
    path: '/v1/dev/sessions',
    body: { userId },
    authentication: 'none',
  });
  client.rememberCsrfToken(data.csrfToken);
  return data;
}

/**
 * Rotate the refresh token. The refresh cookie is the credential; nothing is passed in.
 *
 * The client refreshes on its own when an access token expires (`client.ts`); this helper is
 * for a caller that wants to refresh deliberately. Its 401 is terminal by the client's rule,
 * never a reason to refresh again.
 */
export async function refreshSession(client: ApiClient): Promise<EstablishedSession> {
  const { data } = await client.request<EstablishedSession>({
    method: 'POST',
    path: REFRESH_PATH,
    authentication: 'none',
  });
  client.rememberCsrfToken(data.csrfToken);
  return data;
}

/** AUTHSTATE: how long the session check waits before it calls the API unreachable. */
export const SESSION_CHECK_TIMEOUT_MS = 10_000;

/** AUTHSTATE: the person this browser's session belongs to (`GET /v1/sessions/current`). */
export interface SessionAccount {
  readonly email: string;
  readonly displayName: string;
}

/** The body of `GET /v1/sessions/current`. */
export interface CurrentSession {
  readonly account: SessionAccount;
}

/**
 * Ask the API who is signed in, WITHOUT the client's own refresh-and-announce recovery: the
 * shared session check (`lib/session-check.ts`) runs the refresh itself, so it can tell a
 * refused session from an API that did not answer. A request that hangs (a restart) is
 * abandoned after {@link SESSION_CHECK_TIMEOUT_MS} and counts as no answer.
 */
export async function getCurrentSession(client: ApiClient): Promise<SessionAccount> {
  const { data } = await client.request<CurrentSession>({
    path: '/v1/sessions/current',
    authentication: 'none',
    signal: AbortSignal.timeout(SESSION_CHECK_TIMEOUT_MS),
  });
  return data.account;
}

/**
 * Sign out of this session. Idempotent — a second call changes nothing.
 *
 * The remembered CSRF token is dropped whether or not the API answered: the caller is about
 * to announce the sign-out on the authentication boundary, and a token bound to a session
 * that is ending has nothing left to authorise.
 */
export async function signOut(client: ApiClient): Promise<void> {
  try {
    await client.request<void>({ method: 'DELETE', path: '/v1/sessions/current' });
  } finally {
    client.forgetCsrfToken();
    // FIX5 security review L6: no unsaved doc text stays behind for the next person.
    clearAllDraftBackups();
  }
}

/** The device/session list — `04-SECURITY-PRIVACY` §3, screen ID-05. */
export async function listDevices(client: ApiClient): Promise<readonly SessionSummary[]> {
  const { data } = await client.request<{ readonly sessions: readonly SessionSummary[] }>({
    path: '/v1/sessions/current/devices',
  });
  return data.sessions;
}
