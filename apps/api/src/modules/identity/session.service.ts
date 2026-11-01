import type { TenantDatabase } from '../../common/database/tenant-context.js';
import {
  expireCookie,
  hashRefreshToken,
  issueRefreshToken,
  serializeCookie,
  serializeReadableCookie,
  signAccessToken,
  verifyAccessToken,
} from './session-token.js';
import { mintCsrfToken, verifyCsrfToken } from '../../common/http/csrf.js';
import type { CookieAttributes } from './session-token.js';
import { SessionsRepository, storableIp } from './sessions.repository.js';
import type { SessionSummary } from './sessions.repository.js';
import type { IpRecorder } from './geo/ip-intelligence.service.js';

/**
 * ID-001 — session authentication, refresh rotation, and reuse detection.
 *
 * This is spec §3 **step 1**, the step the membership resolver deliberately starts after.
 * `MembershipResolver.resolve()` takes a `userId` that "authentication has already
 * established"; this is what establishes it. The two together are steps 1 to 3, and the HTTP
 * surface will be the thing that calls them in order.
 *
 * ## Why every request reads the database
 *
 * `authenticate()` verifies the access token's signature and then loads the session row. The
 * second half is not redundant. `04-SECURITY-PRIVACY` §3 requires "immediate server-side
 * revocation on offboarding and sensitive permission changes", and a token trusted on its
 * signature alone is valid until it expires no matter what the server decides in between —
 * "immediate" would silently mean "within fifteen minutes". The signature's job is to reject
 * forgeries before they cost a round trip, and to stop a client nominating a session id of
 * its own, which is what session fixation is.
 *
 * ## Reuse detection, and what it costs
 *
 * A refresh token is single-use. Presenting one that has already been rotated away means one
 * of two things — the token was stolen and the thief is behind, or the token was stolen and
 * the legitimate user is behind — and the server cannot tell which. Both readings say the
 * session is compromised, so the whole session is revoked, not just the request refused.
 *
 * The cost is a real one and is recorded rather than smoothed over: two browser tabs
 * refreshing concurrently is **not** reuse (the compare-and-swap makes exactly one of them
 * win and tells the other it lost), but a client that retries a refresh whose response it
 * never received **is** indistinguishable from a replay, and will lose its session. The usual
 * mitigation is a short grace window in which the immediately-previous token is accepted
 * again; that weakens the detector by exactly the width of the window, and choosing the width
 * is a product decision the pack does not make. It is left out rather than invented — see
 * the open gaps in `docs/implementation-status.md`.
 *
 * ## One message for every refusal
 *
 * The same rule the membership resolver follows, for the same reason. "No such session",
 * "revoked", "expired" and "replayed" are four different audit entries and one caller-facing
 * answer. The cause travels in `code`.
 */

/** The global tables this service reaches. Enforced by `TenantDatabase.identity*`. */
const IDENTITY_TABLES = ['sessions', 'session_refresh_tokens'] as const;
/** Platform admin v2 (PA-06): the session check also reads the account's standing (0247). */
const AUTHENTICATE_TABLES = ['sessions', 'users'] as const;

/** Recorded on `sessions.revoked_reason`. A security finding, not a lifecycle event. */
export const REUSE_REVOCATION_REASON = 'refresh_reuse_detected';

/** R3. Recorded on `sessions.revoked_reason` when a session is refused for inactivity. */
export const IDLE_SIGNOUT_REASON = 'idle_signout';

/**
 * R3. Was this session idle (since its last refresh, by the database clock) longer than the
 * idle limit stamped on it? No limit stamped, or no idle measurement, is never idle.
 */
export function idleBeyondLimit(state: {
  readonly session: { readonly idleLimitMinutes?: number | null };
  readonly idleSeconds?: number;
}): boolean {
  const limit = state.session.idleLimitMinutes;
  if (limit === null || limit === undefined || limit <= 0) return false;
  if (state.idleSeconds === undefined || !Number.isFinite(state.idleSeconds)) return false;
  return state.idleSeconds > limit * 60;
}

export interface SessionServiceOptions {
  /** `SESSION_COOKIE_NAME`. The refresh cookie is this name with `_refresh` appended. */
  readonly cookieName: string;
  /** `SESSION_SECRET`. Signs access tokens; never leaves this process. */
  readonly sessionSecret: string;
  /** `SESSION_TTL_SECONDS` — the short-lived half. */
  readonly accessTtlSeconds: number;
  /** `REFRESH_TTL_SECONDS` — the session's absolute lifetime. */
  readonly refreshTtlSeconds: number;
  /**
   * The one path the refresh cookie is sent to.
   *
   * Scoping it means the long-lived credential is absent from every ordinary request, so an
   * ordinary request cannot leak it — through a log, a proxy, a crash report, or a
   * mis-scoped handler that echoes headers.
   */
  readonly refreshCookiePath: string;
  /** False only for plain-HTTP local development. */
  readonly secureCookies: boolean;
  /**
   * `CSRF_SECRET`. Distinct from `sessionSecret`, and `packages/config` refuses a production
   * boot where the two are equal — one secret signing both a credential and the token that
   * protects it means a leak of either is a leak of both.
   */
  readonly csrfSecret: string;
  /** The readable cookie the client echoes in `X-CSRF-Token`. */
  readonly csrfCookieName: string;
}

export type SessionRejection =
  | 'no_cookie'
  | 'malformed'
  | 'unsupported_version'
  | 'bad_signature'
  | 'access_expired'
  | 'session_unknown'
  | 'session_revoked'
  | 'session_expired'
  // ---- platform-admin v2 · PA-06 ---- a platform admin disabled the account (0247).
  | 'account_disabled';

export type RefreshRejection =
  | 'no_cookie'
  | 'unknown_token'
  | 'reuse_detected'
  | 'session_revoked'
  | 'session_expired'
  | 'rotation_lost'
  | 'csrf_failed'
  // R3. Idle longer than the strictest company "Sign out after inactivity" limit it acted under.
  | 'idle_timeout';

const AUTHENTICATION_REFUSAL = 'The request carries no valid session';
const REFRESH_REFUSAL = 'The refresh token was not accepted';

export class SessionNotAuthenticatedError extends Error {
  constructor(readonly code: SessionRejection) {
    super(AUTHENTICATION_REFUSAL);
    this.name = 'SessionNotAuthenticatedError';
  }
}

export class RefreshRejectedError extends Error {
  constructor(
    readonly code: RefreshRejection,
    /** Set only for `reuse_detected`: the session this refusal revoked. For the audit event. */
    readonly revokedSessionId?: string,
  ) {
    super(REFRESH_REFUSAL);
    this.name = 'RefreshRejectedError';
  }
}

/** What a verified request carries into spec §3 step 2. */
export interface AuthenticatedSession {
  readonly sessionId: string;
  readonly userId: string;
}

/**
 * Platform admin v2 (PA-06): the verified session plus the one standing fact the guard acts on —
 * an operator requires two-step for this account (`users.two_step_required_at`, 0247).
 */
export interface AuthenticatedSessionStanding extends AuthenticatedSession {
  readonly twoStepRequired: boolean;
}

/**
 * A newly established or newly rotated session.
 *
 * `accessToken` and `refreshToken` are the credentials themselves. They are returned rather
 * than only embedded in `cookies` because the HTTP layer should never have to parse its own
 * output to find them — and they must never be logged, which is the one thing a reader of
 * this type needs to know.
 */
export interface EstablishedSession {
  readonly sessionId: string;
  readonly userId: string;
  /** The session's absolute deadline, unchanged by rotation. */
  readonly expiresAt: Date;
  readonly accessToken: string;
  readonly refreshToken: string;
  /**
   * The CSRF token for this session. Returned so the HTTP layer never has to re-derive it,
   * and so a caller that is not a browser can use the API without parsing `Set-Cookie`.
   */
  readonly csrfToken: string;
  /** `Set-Cookie` values, in order: access, refresh, then the readable CSRF token. */
  readonly cookies: readonly string[];
}

export interface StartSessionInput {
  /** Established by whatever proved the person's identity — password, passkey, SSO (ID-002). */
  readonly userId: string;
  readonly userAgent?: string | null;
  readonly correlationId: string;
  /** Platform admin v2 (0247): stamped as `ip_first` and `ip_last`. */
  readonly ip?: string | null;
  /**
   * R12 (0280). Link the session to the succeeded sign-in event this request (`correlationId`)
   * wrote, as `sessions.sign_in_event_id`.
   */
  readonly linkSignInEvent?: boolean;
}

/**
 * The wire body of `POST /v1/dev/sessions` and `POST /v1/sessions/refresh` — the two fields the
 * controller writes after a session is established or rotated.
 *
 * Distinct from {@link EstablishedSession}, which is the internal result the service hands the
 * controller: that type also carries the credentials and the `Set-Cookie` values and dates
 * `expiresAt` as a `Date`. This is only what leaves the process, with `expiresAt` as the ISO
 * string the controller already serialises it to (`expiresAt.toISOString()`), so `apps/web`'s
 * `EstablishedSession` can be paired against it exactly.
 */
export interface EstablishedSessionView {
  readonly csrfToken: string;
  readonly expiresAt: string;
}

/**
 * The wire shape of one row of the device/session list — `GET /v1/sessions/current/devices`.
 *
 * {@link SessionSummary} in `sessions.repository.ts` is the same five fields with `createdAt`,
 * `rotatedAt` and `expiresAt` typed as `Date`, because that is what the query returns. This is
 * what the controller sends: those three as the ISO strings JSON serialises a `Date` to, which
 * is exactly what `apps/web`'s `SessionSummary` reads.
 */
export interface SessionSummaryView {
  readonly id: string;
  readonly userAgent: string | null;
  readonly createdAt: string;
  readonly rotatedAt: string | null;
  readonly expiresAt: string;
}

export class SessionService {
  private readonly sessions: SessionsRepository;

  constructor(
    private readonly database: TenantDatabase,
    private readonly options: SessionServiceOptions,
    sessions: SessionsRepository = new SessionsRepository(),
    /** R12. Records the address's place/network in `ip_lookups` where `ip_last` moves. */
    private readonly ipRecorder: IpRecorder | null = null,
  ) {
    this.sessions = sessions;
  }

  /** R12. Best effort, after the commit: `record` itself never throws. */
  private recordIp(ip: string | null | undefined, correlationId: string): void {
    if (this.ipRecorder && storableIp(ip) !== null) {
      void this.ipRecorder.record(ip, correlationId);
    }
  }

  /** The name the refresh cookie is set under. Derived, so the two can never disagree. */
  get refreshCookieName(): string {
    return `${this.options.cookieName}_refresh`;
  }

  /**
   * Begin a session for an already-authenticated person.
   *
   * What "already-authenticated" means is deliberately outside this method: password
   * verification, passkeys, MFA and SSO are ID-002 and are not written. Taking a `userId`
   * rather than a credential keeps that boundary visible instead of implying a check that
   * does not exist.
   */
  async start(input: StartSessionInput): Promise<EstablishedSession> {
    const refresh = issueRefreshToken();

    const session = await this.database.identityTransaction(
      {
        correlationId: input.correlationId,
        tables: input.linkSignInEvent
          ? [...IDENTITY_TABLES, 'authentication_events']
          : [...IDENTITY_TABLES],
      },
      async (tx) => {
        const created = await this.sessions.create(tx, {
          userId: input.userId,
          refreshTokenHash: refresh.hash,
          userAgent: input.userAgent ?? null,
          ttlSeconds: this.options.refreshTtlSeconds,
          ip: input.ip ?? null,
        });
        if (input.linkSignInEvent) {
          await this.sessions.linkSignInEvent(tx, {
            sessionId: created.id,
            userId: input.userId,
            correlationId: input.correlationId,
          });
        }
        return created;
      },
    );

    return this.established(session.id, session.userId, session.expiresAt, refresh.token);
  }

  /**
   * Verify the access cookie and confirm the session is still live — spec §3 step 1.
   *
   * The signature is checked before the database is touched, so a flood of forged cookies
   * costs CPU rather than connections.
   */
  async authenticate(input: {
    readonly accessToken: string | undefined;
    readonly correlationId: string;
    /** Platform admin v2 (0247): the request's address, stamped when it changed. */
    readonly ip?: string | null;
  }): Promise<AuthenticatedSessionStanding> {
    if (!input.accessToken) throw new SessionNotAuthenticatedError('no_cookie');

    const verified = verifyAccessToken(input.accessToken, this.options.sessionSecret);
    if (!verified.ok) {
      throw new SessionNotAuthenticatedError(
        verified.reason === 'expired' ? 'access_expired' : verified.reason,
      );
    }

    const found = await this.database.identityRead(
      { correlationId: input.correlationId, tables: [...AUTHENTICATE_TABLES] },
      async (tx) => {
        const state = await this.sessions.findById(tx, verified.claims.sessionId);
        const standing = state ? await this.sessions.findStanding(tx, state.session.userId) : null;
        return { state, standing };
      },
    );
    const { state, standing } = found;

    if (!state) throw new SessionNotAuthenticatedError('session_unknown');
    if (state.session.revokedAt !== null) throw new SessionNotAuthenticatedError('session_revoked');
    if (state.expired) throw new SessionNotAuthenticatedError('session_expired');
    // ---- platform-admin v2 · PA-06 ---- A disabled account is refused like any dead session:
    // the same 401, the cause on `auditCode` only.
    if (standing?.disabledAt) throw new SessionNotAuthenticatedError('account_disabled');

    // `ip_first`/`ip_last` (0247): written only when the address moved, so an ordinary request
    // costs no write. Best-effort: an address stamp never refuses a live session.
    const address = storableIp(input.ip);
    if (address !== null && state.session.ipLast !== address) {
      await this.database
        .identityTransaction({ correlationId: input.correlationId, tables: ['sessions'] }, (tx) =>
          this.sessions.stampAddress(tx, state.session.id, address),
        )
        .catch(() => undefined);
      this.recordIp(address, input.correlationId);
    }

    return {
      sessionId: state.session.id,
      userId: state.session.userId,
      twoStepRequired: Boolean(standing?.twoStepRequiredAt),
    };
  }

  /**
   * Rotate the refresh token, or detect that it has already been rotated.
   *
   * The transaction returns a verdict rather than throwing, and the throw happens after the
   * commit. That ordering is load-bearing: reuse detection **revokes the session**, and
   * throwing from inside the transaction would roll that revocation back — leaving the
   * compromised session live and the refusal looking like an ordinary failure.
   */
  async refresh(input: {
    readonly refreshToken: string | undefined;
    /**
     * The `X-CSRF-Token` header, verified here rather than by `CsrfGuard`.
     *
     * The refresh request carries no access cookie, so its session id is unknown until the
     * refresh token has been looked up — and the token is bound to the session id (ADR-0004).
     * Verification therefore has to happen at the first point the session id exists, which is
     * inside the transaction below, **after** resolution and **before** the rotation commits.
     *
     * This service already owns cookie serialisation for the same reason, so the seam is not a
     * new one. What matters is that a bad token refuses with the same generic message as every
     * other refresh failure and leaves the session untouched.
     */
    readonly csrfToken: string | undefined;
    readonly correlationId: string;
    /** Platform admin v2 (0247): moves `ip_last`. */
    readonly ip?: string | null;
  }): Promise<EstablishedSession> {
    if (!input.refreshToken) throw new RefreshRejectedError('no_cookie');

    const presented = hashRefreshToken(input.refreshToken);
    const next = issueRefreshToken();

    const outcome = await this.database.identityTransaction(
      { correlationId: input.correlationId, tables: [...IDENTITY_TABLES] },
      async (tx): Promise<RefreshOutcome> => {
        const live = await this.sessions.findByLiveTokenHash(tx, presented);

        if (live) {
          if (live.session.revokedAt !== null) return { kind: 'rejected', code: 'session_revoked' };
          if (live.expired) return { kind: 'rejected', code: 'session_expired' };

          // CSRF, at the first moment the session id is known and before anything is written.
          // Returning a verdict rather than throwing keeps the transaction's single exit
          // discipline: a throw from in here would roll back, which for a *rejection* is
          // harmless but would diverge from the reuse path immediately below, where it is not.
          if (!verifyCsrfToken(input.csrfToken, live.session.id, this.options.csrfSecret)) {
            return { kind: 'rejected', code: 'csrf_failed' };
          }

          // R3. Activity is a refresh: a session idle since its last one for longer than the
          // company's "Sign out after inactivity" limit is ended here, inside the transaction so
          // the revocation commits with the refusal.
          if (idleBeyondLimit(live)) {
            await this.sessions.revoke(tx, live.session.id, IDLE_SIGNOUT_REASON);
            return { kind: 'rejected', code: 'idle_timeout', sessionId: live.session.id };
          }

          const rotated = await this.sessions.rotate(tx, {
            sessionId: live.session.id,
            currentHash: presented,
            nextHash: next.hash,
            // The superseded token has been live since the previous rotation, or since the
            // session began if this is the first one.
            issuedAt: live.session.rotatedAt ?? live.session.createdAt,
            ip: input.ip ?? null,
          });
          if (!rotated) return { kind: 'rejected', code: 'rotation_lost' };

          return {
            kind: 'rotated',
            sessionId: live.session.id,
            userId: live.session.userId,
            expiresAt: live.session.expiresAt,
          };
        }

        // Not live. If the ledger has seen it, it was rotated away and is now being replayed.
        const superseded = await this.sessions.findSupersededToken(tx, presented);
        if (superseded) {
          await this.sessions.revoke(tx, superseded.sessionId, REUSE_REVOCATION_REASON);
          return { kind: 'rejected', code: 'reuse_detected', sessionId: superseded.sessionId };
        }

        return { kind: 'rejected', code: 'unknown_token' };
      },
    );

    if (outcome.kind === 'rejected') {
      throw new RefreshRejectedError(outcome.code, outcome.sessionId);
    }
    this.recordIp(input.ip, input.correlationId);

    return this.established(outcome.sessionId, outcome.userId, outcome.expiresAt, next.token);
  }

  /** End one session — sign-out, or an administrative revocation with its own reason. */
  async revoke(input: {
    readonly sessionId: string;
    readonly reason: string;
    readonly correlationId: string;
  }): Promise<boolean> {
    return this.database.identityTransaction(
      { correlationId: input.correlationId, tables: [...IDENTITY_TABLES] },
      (tx) => this.sessions.revoke(tx, input.sessionId, input.reason),
    );
  }

  /** The global cutoff: end every live session this person holds. */
  async revokeAllForUser(input: {
    readonly userId: string;
    readonly reason: string;
    readonly correlationId: string;
  }): Promise<number> {
    return this.database.identityTransaction(
      { correlationId: input.correlationId, tables: [...IDENTITY_TABLES] },
      (tx) => this.sessions.revokeAllForUser(tx, input.userId, input.reason),
    );
  }

  /**
   * Platform admin v2 (PA-06): end ONE session of this person ("End this session", B3). `false`
   * when it is not theirs or already ended.
   */
  async revokeOneForUser(input: {
    readonly userId: string;
    readonly sessionId: string;
    readonly reason: string;
    readonly correlationId: string;
  }): Promise<boolean> {
    return this.database.identityTransaction(
      { correlationId: input.correlationId, tables: [...IDENTITY_TABLES] },
      (tx) => this.sessions.revokeOneForUser(tx, input),
    );
  }

  /** The device/session list (04 §3). Carries no credential material. */
  async listForUser(input: {
    readonly userId: string;
    readonly correlationId: string;
  }): Promise<readonly SessionSummary[]> {
    return this.database.identityRead(
      { correlationId: input.correlationId, tables: [...IDENTITY_TABLES] },
      (tx) => this.sessions.listForUser(tx, input.userId),
    );
  }

  /**
   * The `Set-Cookie` pair that removes both credentials.
   *
   * Path and `SameSite` are restated from the same attribute builders that set them, because
   * a browser treats a differently-scoped cookie as a different cookie — and a sign-out that
   * clears the access cookie while leaving a working refresh cookie in place is worse than no
   * sign-out at all, since it looks like it worked.
   */
  clearedCookies(): readonly string[] {
    const access = this.accessCookieAttributes(0);
    const refresh = this.refreshCookieAttributes(0);
    return [
      expireCookie(this.options.cookieName, {
        path: access.path,
        sameSite: access.sameSite,
        secure: access.secure,
      }),
      expireCookie(this.refreshCookieName, {
        path: refresh.path,
        sameSite: refresh.sameSite,
        secure: refresh.secure,
      }),
      // The CSRF cookie authorises nothing on its own, so leaving it behind would not be a
      // security failure — but it would leave a stale token bound to a dead session, and the
      // next sign-in would then have two values under the same name at different ages. Cleared
      // for the same reason the other two are: sign-out means all of it.
      expireCookie(this.options.csrfCookieName, {
        path: access.path,
        sameSite: access.sameSite,
        secure: access.secure,
      }),
    ];
  }

  /**
   * `SameSite=Lax`, not `Strict`.
   *
   * A `Strict` session cookie is not sent on a top-level navigation from another site, so
   * every link into the product — an emailed notification, a client's bookmark of a shared
   * deliverable — would land on a signed-out page. `Lax` withholds the cookie from
   * cross-site subrequests and from cross-site form posts, which is the part that matters,
   * and CSRF protection for state-changing requests is a separate control (04 §3) rather
   * than something `SameSite` is asked to carry alone.
   */
  private accessCookieAttributes(maxAgeSeconds: number): CookieAttributes {
    return {
      path: '/',
      maxAgeSeconds,
      sameSite: 'Lax',
      secure: this.options.secureCookies,
    };
  }

  /**
   * `SameSite=Strict` for the refresh cookie, and a path of its own.
   *
   * Nothing ever navigates to the refresh endpoint from another site; it is called by the
   * application's own code. So the looser setting buys nothing here and the stricter one
   * removes a whole class of cross-site interaction with the long-lived credential.
   */
  private refreshCookieAttributes(maxAgeSeconds: number): CookieAttributes {
    return {
      path: this.options.refreshCookiePath,
      maxAgeSeconds,
      sameSite: 'Strict',
      secure: this.options.secureCookies,
    };
  }

  /**
   * Mint the access token and both cookies for a session that already exists.
   *
   * The access token never outlives the session: its expiry is the earlier of "now plus the
   * access TTL" and the session's own absolute deadline. Without the clamp, a session in its
   * last minute would still hand out a fifteen-minute access token, and the absolute deadline
   * would mean nothing for the length of one access window.
   */
  private established(
    sessionId: string,
    userId: string,
    sessionExpiresAt: Date,
    refreshToken: string,
  ): EstablishedSession {
    const accessDeadline = new Date(Date.now() + this.options.accessTtlSeconds * 1000);
    const expiresAt =
      accessDeadline.getTime() < sessionExpiresAt.getTime() ? accessDeadline : sessionExpiresAt;

    const accessToken = signAccessToken({ sessionId, expiresAt }, this.options.sessionSecret);
    const remainingSeconds = Math.max(
      0,
      Math.floor((sessionExpiresAt.getTime() - Date.now()) / 1000),
    );

    const csrfToken = mintCsrfToken(sessionId, this.options.csrfSecret);

    return {
      sessionId,
      userId,
      expiresAt: sessionExpiresAt,
      accessToken,
      refreshToken,
      csrfToken,
      cookies: [
        serializeCookie(
          this.options.cookieName,
          accessToken,
          this.accessCookieAttributes(
            Math.max(0, Math.floor((expiresAt.getTime() - Date.now()) / 1000)),
          ),
        ),
        serializeCookie(
          this.refreshCookieName,
          refreshToken,
          // The cookie is dropped by the browser when the session's absolute deadline passes,
          // rather than being re-armed for another full refresh TTL on every rotation.
          this.refreshCookieAttributes(remainingSeconds),
        ),
        // The one readable cookie — see `serializeReadableCookie` and ADR-0004. It is scoped
        // and aged exactly like the access cookie so that a client never holds a CSRF token
        // for a session whose access cookie has already gone.
        serializeReadableCookie(
          this.options.csrfCookieName,
          csrfToken,
          this.accessCookieAttributes(remainingSeconds),
        ),
      ],
    };
  }
}

type RefreshOutcome =
  | {
      readonly kind: 'rotated';
      readonly sessionId: string;
      readonly userId: string;
      readonly expiresAt: Date;
    }
  | {
      readonly kind: 'rejected';
      readonly code: RefreshRejection;
      /** Present for `reuse_detected`. */
      readonly sessionId?: string;
    };
