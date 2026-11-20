import type { ApiClient } from './api/client';
import { ApiRequestError } from './api/errors';
import { getCurrentSession, type SessionAccount } from './api/session';

/**
 * AUTHSTATE (live 2026-11-20) — the web's ONE answer to "who is signed in here?"
 * (ENGINEERING-RULES §1.3, §2.3). Every signed-in area and every entry page asks it.
 *
 * It asks `GET /v1/sessions/current`. A 401 is first answered with one refresh (the client's
 * coalesced, cross-tab-locked attempt), then asked again: an access cookie lives 15 minutes and
 * the refresh cookie is sent only to `/v1/sessions/refresh`, so a valid session can answer 401.
 *
 * - **signed-out**: only a definite 401 — a refused refresh, or a 401 straight after a good one.
 * - **unknown**: anything else — no answer, a timeout, a 5xx, a 429, any other status. The caller
 *   says "can't reach TManage, retrying", retries, and never shows the sign-in form for it (a
 *   deploy restart is not a sign-out) and never clears a cookie.
 *
 * No readable CSRF cookie means signed out without a request: the API sets and clears it with the
 * session cookies, and the refresh needs it, so no session can be resumed without it.
 */
export type SessionCheck =
  | { readonly state: 'signed-in'; readonly account: SessionAccount }
  | { readonly state: 'signed-out' }
  | { readonly state: 'unknown' };

export interface SessionCheckOptions {
  /** The readable CSRF cookie is present (`browserMayHaveSession`); injected in tests. */
  readonly mayHaveSession: boolean;
}

const SIGNED_OUT: SessionCheck = { state: 'signed-out' };
const UNKNOWN: SessionCheck = { state: 'unknown' };

/** True for an answer that says nothing about access: no answer, 5xx, 429, 408. */
export function isTransientFailure(error: unknown): boolean {
  if (!(error instanceof ApiRequestError)) return true;
  return error.status >= 500 || error.status === 429 || error.status === 408;
}

async function ask(client: ApiClient): Promise<SessionCheck | 'expired'> {
  try {
    return { state: 'signed-in', account: await getCurrentSession(client) };
  } catch (error) {
    return error instanceof ApiRequestError && error.status === 401 ? 'expired' : UNKNOWN;
  }
}

export async function checkSession(
  client: ApiClient,
  { mayHaveSession }: SessionCheckOptions,
): Promise<SessionCheck> {
  if (!mayHaveSession) return SIGNED_OUT;
  const first = await ask(client);
  if (first !== 'expired') return first;

  const resumed = await client.resumeSession();
  if (resumed === 'ended') return SIGNED_OUT;
  if (resumed === 'unreachable') return UNKNOWN;

  const second = await ask(client);
  return second === 'expired' ? SIGNED_OUT : second;
}
