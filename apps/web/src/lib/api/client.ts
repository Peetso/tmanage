import { ApiRequestError, NetworkError, toApiRequestError } from './errors';

/**
 * The single way this application talks to the API.
 *
 * One function, because the three things every mutating request must do — send cookies,
 * echo the CSRF token, carry a correlation ID — are exactly the three things a hand-written
 * `fetch` forgets. `04-SECURITY-PRIVACY` §3 requires the CSRF header on every unsafe method;
 * `13-ENGINEERING-EXECUTION-SPEC` §3 requires the correlation ID to reach the error envelope.
 * Neither is optional, so neither is a parameter.
 *
 * ## Where the CSRF token comes from
 *
 * The API mints `HMAC(CSRF_SECRET, sessionId)` and returns it two ways: in the response body
 * of sign-in and refresh, and in a readable (non-`HttpOnly`) cookie. This client uses both,
 * in that order:
 *
 * 1. **Memory.** The value the API returned to *this tab* when it signed in or refreshed. It
 *    is deterministic per session, so a refresh in another tab does not stale it. Holding it
 *    means the token works even where the cookie is not readable — an API on another host
 *    (review finding D03) — for as long as the tab lives.
 * 2. **The cookie.** For a page loaded fresh — a reload, a second tab, a bookmark — which has
 *    no memory. The API's own comment explains why that cookie is safe to expose: the token
 *    authorises nothing on its own, and a cross-origin attacker cannot read it.
 *
 * `document.cookie` rather than `localStorage` is also what the workspace lint rule requires:
 * browser storage is never authoritative state (15-AI-EXECUTION-HANDBOOK §8). The cookie is
 * not storage the app owns — it is the server's value, which the app echoes. The in-memory
 * copy is a React-lifetime value, not storage: it dies with the tab.
 *
 * ## Session recovery (review finding D04)
 *
 * Access tokens live `SESSION_TTL_SECONDS` (900 by default); the refresh cookie lives two
 * weeks. Until this change nothing in the browser ever called refresh, so a person who paused
 * for sixteen minutes was signed out with a two-week credential still in their cookie jar.
 *
 * Now a request refused with 401 `unauthenticated` is treated as "the access token has gone",
 * the session is refreshed **once**, and the request is sent **once more**. The rules:
 *
 * - **One refresh at a time in this tab.** Every request that fails while a refresh is in
 *   flight waits for that refresh rather than starting its own; a burst of expired requests
 *   is one rotation, not ten.
 * - **One refresh at a time across tabs** (`lock`, `navigator.locks` in the browser). Two tabs
 *   presenting the same refresh token at once is exactly the pattern the API's reuse detection
 *   revokes the session for — and it would be right to, from where it stands. The lock makes
 *   the second tab wait, by which time the cookie jar already holds the rotated token.
 * - **The refused request is replayed whatever its method.** A 401 is a refusal before the
 *   handler ran — `SessionAuthGuard` answers it — so the write was not applied and replaying
 *   it applies it once. What is never replayed is a request whose outcome is *ambiguous*: a
 *   `NetworkError` is thrown to the caller as before, because the write may have landed.
 * - **Refresh's own refusal is terminal.** A 401 from the refresh route means the refresh
 *   cookie is gone, expired, revoked or reused. `onSessionEnded` is called once and the
 *   original refusal is thrown; the application clears its caches and asks the person to sign
 *   in. A refresh that cannot *reach* the API ends nothing — the original 401 is thrown and the
 *   person is not signed out over a dropped connection.
 * - **Public routes never trigger it.** Sign-in itself answers 401 to a wrong password;
 *   refreshing on that would send a person to the sign-in screen for mistyping on the sign-in
 *   screen. Helpers for routes that authenticate by something other than the session say so
 *   with `authentication: 'none'`.
 */

/** The header the API's `CsrfGuard` reads. Must match `apps/api/src/common/http/csrf.ts`. */
export const CSRF_HEADER = 'x-csrf-token';

/** The header the API's correlation interceptor reads and echoes. */
export const CORRELATION_HEADER = 'x-correlation-id';

/**
 * The refresh route. Named here because the client has to recognise it: a 401 from this path
 * is the end of the session, not a reason to refresh.
 */
export const REFRESH_PATH = '/v1/sessions/refresh';

/** Methods that never mutate, and so never carry a CSRF token. */
const SAFE_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD', 'OPTIONS']);

/** Why a session ended without the person asking it to. */
export type SessionEndReason = 'refresh_refused';

export interface SessionRecoveryOptions {
  /**
   * Run `work` while holding a cross-tab mutual exclusion. Absent where there is none (tests,
   * server rendering, a browser without `navigator.locks`), in which case `work` runs directly
   * and only the in-tab coalescing protects the refresh token.
   */
  readonly lock?: <T>(work: () => Promise<T>) => Promise<T>;
  /** Called once per terminal failure. The application decides what a person then sees. */
  readonly onSessionEnded: (reason: SessionEndReason) => void;
}

export interface ApiClientOptions {
  /**
   * Absolute origin of the API, e.g. `http://localhost:3001`, with no trailing slash — or the
   * empty string when the API is reached through this page's own origin (`public-config.ts`).
   */
  readonly baseUrl: string;
  /**
   * The cookie the readable CSRF token lives in. Derived by the API from
   * `SESSION_COOKIE_NAME`, so it is configuration here rather than a constant.
   */
  readonly csrfCookieName: string;
  /** Injectable so tests do not need a real network, and so nothing here touches a global. */
  readonly fetch: typeof globalThis.fetch;
  /** Injectable for the same reason: a test asserts on the exact header value. */
  readonly readCsrfToken: () => string | undefined;
  /** Injectable so a test can assert the correlation ID reached the request. */
  readonly newCorrelationId: () => string;
  /**
   * Session recovery. Optional so a test can assert on the raw refusal, and so a client with
   * nowhere to send a signed-out person (none exists today) can decline to recover.
   */
  readonly recovery?: SessionRecoveryOptions;
  /**
   * A11. Called when a request is refused with 403 `two_step_required` — the company requires
   * two-step sign-in and this person has not turned it on. The refusal is still thrown; the
   * application decides where the person goes (the enrolment screen).
   */
  readonly onTwoStepRequired?: (requestPath: string) => void;
}

export interface ApiRequest {
  readonly method?: string;
  readonly path: string;
  readonly body?: unknown;
  readonly signal?: AbortSignal;
  /**
   * What authenticates this request. `session` (the default) is the access cookie, and a 401
   * means the access token has expired — recoverable. `none` is a route that proves identity
   * some other way — a password, a challenge token, an invitation — and its 401 is an answer,
   * not an expiry.
   */
  readonly authentication?: 'session' | 'none';
  /**
   * Extra request headers a route requires beyond the three this client always sends — today
   * only `Idempotency-Key` on an upload session. They cannot replace the CSRF, correlation or
   * content-type headers: those are set after these and win.
   */
  readonly headers?: Readonly<Record<string, string>>;
}

export interface ApiResponse<T> {
  readonly data: T;
  readonly correlationId: string;
}

/**
 * Read one cookie from `document.cookie`.
 *
 * Exported because the default `readCsrfToken` is built from it and a test asserts the
 * parsing directly — a cookie header is a shared namespace, and a prefix match would happily
 * return `tmanage_session_csrf_other` for `tmanage_session_csrf`.
 */
export function readCookie(cookieHeader: string, name: string): string | undefined {
  for (const part of cookieHeader.split(';')) {
    const separator = part.indexOf('=');
    if (separator === -1) continue;
    if (part.slice(0, separator).trim() !== name) continue;
    return decodeURIComponent(part.slice(separator + 1).trim());
  }
  return undefined;
}

/**
 * A correlation ID for one request.
 *
 * `crypto.randomUUID` where it exists. The fallback is not a security value — the ID is a log
 * join key, not a token — so a non-cryptographic source is acceptable when the platform has
 * no `crypto`, and saying so here is cheaper than a reader having to work out whether it
 * matters.
 */
export function newCorrelationId(): string {
  const cryptoRef = globalThis.crypto as Crypto | undefined;
  if (cryptoRef?.randomUUID) return cryptoRef.randomUUID();
  return `web-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e9).toString(36)}`;
}

/** The 401 that means "the access token is gone", as opposed to any other refusal. */
function isAccessExpired(error: unknown): error is ApiRequestError {
  return (
    error instanceof ApiRequestError && error.status === 401 && error.code === 'unauthenticated'
  );
}

export class ApiClient {
  private csrfTokenInMemory: string | undefined;
  private recovering: Promise<boolean> | undefined;

  constructor(private readonly options: ApiClientOptions) {}

  /**
   * Keep the CSRF token the API just returned. Called by the sign-in and refresh helpers, so
   * the value the server handed *this tab* is preferred over whatever cookie is readable.
   */
  rememberCsrfToken(token: string): void {
    this.csrfTokenInMemory = token;
  }

  /** Drop the remembered token. Sign-out, and any change of principal, calls this. */
  forgetCsrfToken(): void {
    this.csrfTokenInMemory = undefined;
  }

  /**
   * Send one request.
   *
   * Throws `ApiRequestError` for anything the API refused and `NetworkError` for anything
   * that never reached it. It never returns an error as a value, because a screen that has
   * to remember to check a discriminated union is a screen that renders `undefined` the one
   * time it forgets.
   */
  async request<T>(request: ApiRequest): Promise<ApiResponse<T>> {
    try {
      return await this.send<T>(request);
    } catch (error) {
      if (error instanceof ApiRequestError && error.code === 'two_step_required') {
        this.options.onTwoStepRequired?.(request.path);
        throw error;
      }
      const recoverable =
        this.options.recovery !== undefined &&
        (request.authentication ?? 'session') === 'session' &&
        request.path !== REFRESH_PATH &&
        isAccessExpired(error);
      if (!recoverable) throw error;

      const recovered = await this.recoverSession();
      if (!recovered) throw error;

      // Once. A second 401 here is not an expiry — the session was just refreshed — and
      // looping would turn a broken deployment into a request storm.
      return this.send<T>(request);
    }
  }

  /**
   * Refresh the session, coalescing every caller in this tab onto one attempt and serialising
   * across tabs. Resolves `true` when a replay is worth making, `false` when it is not.
   */
  private recoverSession(): Promise<boolean> {
    if (this.recovering) return this.recovering;

    const recovery = this.options.recovery;
    if (!recovery) return Promise.resolve(false);

    const attempt = async (): Promise<boolean> => {
      try {
        const { data } = await this.send<{ readonly csrfToken?: unknown }>({
          method: 'POST',
          path: REFRESH_PATH,
        });
        if (typeof data?.csrfToken === 'string') this.rememberCsrfToken(data.csrfToken);
        return true;
      } catch (error) {
        if (error instanceof ApiRequestError && (error.status === 401 || error.status === 403)) {
          // The API has cleared the cookies (`SessionController.refresh`); the tab's memory
          // goes with them, and the application is told once.
          this.forgetCsrfToken();
          recovery.onSessionEnded('refresh_refused');
        }
        // Anything else — the API unreachable, a 5xx — decides nothing about the session.
        return false;
      }
    };

    const run = recovery.lock ? recovery.lock(attempt) : attempt();
    this.recovering = run.finally(() => {
      this.recovering = undefined;
    });
    return this.recovering;
  }

  private async send<T>({
    method = 'GET',
    path,
    body,
    signal,
    headers: extraHeaders,
  }: ApiRequest): Promise<ApiResponse<T>> {
    const correlationId = this.options.newCorrelationId();
    const headers = new Headers(extraHeaders);
    headers.set(CORRELATION_HEADER, correlationId);

    if (body !== undefined) headers.set('content-type', 'application/json');

    if (!SAFE_METHODS.has(method.toUpperCase())) {
      const csrfToken = this.csrfTokenInMemory ?? this.options.readCsrfToken();
      // A missing token is not fixed by omitting the header: the API would answer 403
      // `csrf_failed` either way, and sending nothing loses the chance to say which of the
      // two situations this is. It is sent when present and left off when absent.
      if (csrfToken !== undefined) headers.set(CSRF_HEADER, csrfToken);
    }

    let response: Response;
    try {
      response = await this.options.fetch(`${this.options.baseUrl}${path}`, {
        method,
        headers,
        // The session lives in cookies, possibly on another origin. Without this the browser
        // sends none of them and every authenticated request is a 401 that looks like a bug.
        credentials: 'include',
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        ...(signal ? { signal } : {}),
      });
    } catch (cause) {
      throw new NetworkError('The request did not reach TManage.', cause);
    }

    const responseCorrelationId = response.headers.get(CORRELATION_HEADER) ?? correlationId;

    if (response.status === 204) {
      return { data: undefined as T, correlationId: responseCorrelationId };
    }

    const payload = await readJson(response);

    if (!response.ok) {
      throw toApiRequestError(response.status, payload, responseCorrelationId);
    }

    return { data: payload as T, correlationId: responseCorrelationId };
  }
}

/**
 * Read a JSON body, tolerating one that is not JSON.
 *
 * An error page from a proxy is HTML with an HTTP status; letting `response.json()` throw
 * here would turn a legible 502 into an unhandled `SyntaxError`.
 */
async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text === '') return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/** Re-exported so a screen imports one module rather than two. */
export type { ApiRequestError };
export { NetworkError } from './errors';
