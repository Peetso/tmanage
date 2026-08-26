import { NetworkError, toApiRequestError, type ApiRequestError } from './errors';

/**
 * The single way this application talks to the API.
 *
 * One function, because the three things every mutating request must do — send cookies,
 * echo the CSRF token, carry a correlation ID — are exactly the three things a hand-written
 * `fetch` forgets. `04-SECURITY-PRIVACY` §3 requires the CSRF header on every unsafe method;
 * `13-ENGINEERING-EXECUTION-SPEC` §3 requires the correlation ID to reach the error envelope.
 * Neither is optional, so neither is a parameter.
 *
 * ## Why the CSRF token is read from a cookie
 *
 * The API mints `HMAC(CSRF_SECRET, sessionId)` and returns it two ways: in the response body
 * of sign-in and refresh, and in a readable (non-`HttpOnly`) cookie. Reading the cookie means
 * a page that was loaded fresh — a reload, a second tab, a bookmark — can mutate without
 * first calling refresh to learn the token. The API's own comment explains why that cookie is
 * safe to expose: the token authorises nothing on its own, and a cross-origin attacker cannot
 * read it.
 *
 * `document.cookie` rather than `localStorage` is also what the workspace lint rule requires:
 * browser storage is never authoritative state (15-AI-EXECUTION-HANDBOOK §8). The cookie is
 * not storage the app owns — it is the server's value, which the app echoes.
 */

/** The header the API's `CsrfGuard` reads. Must match `apps/api/src/common/http/csrf.ts`. */
export const CSRF_HEADER = 'x-csrf-token';

/** The header the API's correlation interceptor reads and echoes. */
export const CORRELATION_HEADER = 'x-correlation-id';

/** Methods that never mutate, and so never carry a CSRF token. */
const SAFE_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD', 'OPTIONS']);

export interface ApiClientOptions {
  /** Absolute origin of the API, e.g. `http://localhost:3001`. No trailing slash. */
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
}

export interface ApiRequest {
  readonly method?: string;
  readonly path: string;
  readonly body?: unknown;
  readonly signal?: AbortSignal;
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
 * return `tm_session_csrf_other` for `tm_session_csrf`.
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

export class ApiClient {
  constructor(private readonly options: ApiClientOptions) {}

  /**
   * Send one request.
   *
   * Throws `ApiRequestError` for anything the API refused and `NetworkError` for anything
   * that never reached it. It never returns an error as a value, because a screen that has
   * to remember to check a discriminated union is a screen that renders `undefined` the one
   * time it forgets.
   */
  async request<T>({ method = 'GET', path, body, signal }: ApiRequest): Promise<ApiResponse<T>> {
    const correlationId = this.options.newCorrelationId();
    const headers = new Headers({ [CORRELATION_HEADER]: correlationId });

    if (body !== undefined) headers.set('content-type', 'application/json');

    if (!SAFE_METHODS.has(method.toUpperCase())) {
      const csrfToken = this.options.readCsrfToken();
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
        // The session lives in cookies on another origin. Without this the browser sends
        // none of them and every authenticated request is a 401 that looks like a bug.
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
