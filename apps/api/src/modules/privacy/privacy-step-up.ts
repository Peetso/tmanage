import { ApiError, MESSAGES } from '../../common/http/errors.js';
import { requireRequestState } from '../../common/http/request-state.js';
import type { RequestState } from '../../common/http/request-state.js';
import { verifyReauthToken } from '../identity/reauth-token.js';

/**
 * S13 / F28 — the data-rights acts are a person's own, made in a browser session, with fresh proof.
 *
 * Two layers, both in front of the service:
 *
 * 1. **A person, not a token.** Exporting, downloading an archive, and scheduling or cancelling a
 *    deletion are refused for every bound-token scheme (personal access token, the connector's
 *    internal grant): 403 `forbidden`, audit code `session_required_for_data_rights`. The AI
 *    registry already lists all eight routes as NEVER ("a person does these themselves"); this is
 *    the same rule enforced on the REST path, where a leaked token would otherwise reach it.
 * 2. **Step-up.** `04-SECURITY-PRIVACY` §3 asks for risk-based re-authentication for export. The
 *    export request and the deletion request need the `x-reauth-token` header that
 *    `POST /v1/auth/reauth` mints (password, and the two-step code when one is on), bound to this
 *    very session and five minutes long — the same proof the credential routes take. A missing,
 *    expired, forged or other-session token is 403 `reauthentication_required`, which the privacy
 *    screens answer by asking for the password and retrying.
 *
 * Cancelling a deletion and downloading an archive stay at layer 1: cancelling is the protective
 * act (a person who notices a deletion they did not ask for must be able to stop it at once), and
 * the archive is fetched as a plain link that cannot carry a header — the step-up sits on the
 * request that creates it.
 */

export const PRIVACY_STEP_UP = Symbol.for('tmanage.PrivacyStepUp');

/** The header `POST /v1/auth/reauth`'s token travels in, as on the credential routes. */
export const PRIVACY_REAUTH_HEADER = 'x-reauth-token';

export interface PrivacyRequestLike {
  readonly headers: Record<string, string | string[] | undefined>;
}

/** Layer 1: refuse every scheme but the interactive cookie session. */
export function requirePerson(authScheme: RequestState['authScheme']): void {
  if (authScheme !== 'cookie') {
    throw new ApiError(
      403,
      'forbidden',
      MESSAGES.forbidden,
      undefined,
      'session_required_for_data_rights',
    );
  }
}

/** The `x-reauth-token` header, when one was sent. */
export function reauthTokenOf(request: PrivacyRequestLike): string | undefined {
  const raw = request.headers[PRIVACY_REAUTH_HEADER];
  return typeof raw === 'string' && raw !== '' ? raw : undefined;
}

export class PrivacyStepUp {
  constructor(
    private readonly sessionSecret: string,
    private readonly now: () => number = Date.now,
  ) {}

  /** Layer 1 only — the download and the cancel. */
  person(request: object): void {
    requirePerson(requireRequestState(request).authScheme);
  }

  /** Layers 1 and 2 — the export request and the deletion request. */
  stepUp(request: PrivacyRequestLike): void {
    const state = requireRequestState(request);
    requirePerson(state.authScheme);
    const session = state.session;
    if (!session) {
      throw new ApiError(401, 'unauthenticated', MESSAGES.unauthenticated, undefined, 'no_session');
    }
    const verified = verifyReauthToken(reauthTokenOf(request), this.sessionSecret, this.now());
    const reason = !verified.ok
      ? verified.rejection
      : verified.claims.userId !== session.userId || verified.claims.sessionId !== session.sessionId
        ? 'wrong_session'
        : null;
    if (reason !== null) {
      throw new ApiError(
        403,
        'reauthentication_required',
        'Confirm your password to continue.',
        undefined,
        `privacy_step_up_${reason}`,
      );
    }
  }
}
