/**
 * R45 L3 (54-25, 54-10) — the one outbound door for the token importers.
 *
 * Only three hosts may be called: `api.trello.com`, `app.asana.com` and `api.github.com`, over
 * `https:` on the default port, with no userinfo. Anything else is refused before a socket is
 * opened ({@link assertAllowedUrl}). Redirects are not followed (`redirect: 'manual'`; a 3xx is an
 * error), each body is capped at {@link MAX_PM_RESPONSE_BYTES}, and each request has a timeout.
 *
 * Errors carry fixed text and an HTTP status only: never the credential, never the URL (a Trello
 * or Asana URL can name a private board), never the provider's own error body.
 */

export const PM_ALLOWED_HOSTS = ['api.trello.com', 'app.asana.com', 'api.github.com'] as const;
export type PmAllowedHost = (typeof PM_ALLOWED_HOSTS)[number];

export const MAX_PM_RESPONSE_BYTES = 5 * 1024 * 1024;
export const PM_TIMEOUT_MS = 20_000;

/** The fetch the module binds (global `fetch`); tests pass a stub. */
export type PmFetch = (url: string, init: RequestInit) => Promise<Response>;

/** DI token for {@link PmFetch}; declared here so no shared token file is edited. */
export const PM_FETCHER = Symbol.for('tmanage.PmImportFetcher');

export type PmFetchErrorCode =
  | 'pm_host_refused'
  | 'pm_auth_failed'
  | 'pm_rate_limited'
  | 'pm_redirect_refused'
  | 'pm_not_found'
  | 'pm_response_too_large'
  | 'pm_bad_response'
  | 'pm_unavailable';

export class PmFetchError extends Error {
  constructor(
    readonly code: PmFetchErrorCode,
    message: string,
    readonly status: number | null = null,
    readonly retryAfterSeconds: number | null = null,
  ) {
    super(message);
    this.name = 'PmFetchError';
  }
}

/** `true` when `value` is an https URL on one of {@link PM_ALLOWED_HOSTS}, default port, no userinfo. */
export function isAllowedPmUrl(value: string): boolean {
  if (typeof value !== 'string' || value.length > 4096 || /[\s\\]/u.test(value)) return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:') return false;
  if (url.username !== '' || url.password !== '') return false;
  if (url.port !== '') return false;
  return (PM_ALLOWED_HOSTS as readonly string[]).includes(url.hostname.toLowerCase());
}

export function assertAllowedUrl(value: string): void {
  if (!isAllowedPmUrl(value)) {
    throw new PmFetchError('pm_host_refused', 'That address is not allowed');
  }
}

async function boundedText(response: Response): Promise<string> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_PM_RESPONSE_BYTES) {
    await response.body?.cancel().catch(() => undefined);
    throw new PmFetchError('pm_response_too_large', 'The response is too large');
  }
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_PM_RESPONSE_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new PmFetchError('pm_response_too_large', 'The response is too large');
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function retryAfter(header: string | null): number {
  const seconds = Number(header);
  return Number.isFinite(seconds) && seconds > 0 ? Math.min(3600, Math.ceil(seconds)) : 60;
}

/** One GET under the egress rules; the parsed JSON body. */
export async function pmGetJson(
  fetcher: PmFetch,
  url: string,
  headers: Readonly<Record<string, string>>,
  timeoutMs = PM_TIMEOUT_MS,
): Promise<unknown> {
  assertAllowedUrl(url);
  let response: Response;
  try {
    response = await fetcher(url, {
      method: 'GET',
      headers: { ...headers, Accept: 'application/json' },
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    // The underlying error is dropped on purpose: nothing from the request travels onward.
    throw new PmFetchError('pm_unavailable', 'The service could not be reached');
  }
  const { status } = response;
  const drop = () => response.body?.cancel().catch(() => undefined);
  if (status >= 300 && status < 400) {
    await drop();
    throw new PmFetchError('pm_redirect_refused', 'The service answered with a redirect', status);
  }
  if (status === 401 || status === 403) {
    await drop();
    throw new PmFetchError('pm_auth_failed', 'The service refused the token', status);
  }
  if (status === 404) {
    await drop();
    throw new PmFetchError('pm_not_found', 'The service could not find that item', status);
  }
  if (status === 429) {
    const seconds = retryAfter(response.headers.get('retry-after'));
    await drop();
    throw new PmFetchError('pm_rate_limited', 'The service is rate limiting', status, seconds);
  }
  if (status < 200 || status >= 300) {
    await drop();
    throw new PmFetchError('pm_unavailable', `The service answered ${status}`, status);
  }
  try {
    return JSON.parse(await boundedText(response)) as unknown;
  } catch (error) {
    if (error instanceof PmFetchError) throw error;
    throw new PmFetchError('pm_bad_response', 'The service sent an unreadable response', status);
  }
}

// ─── Small readers shared by the source adapters ────────────────────────

export function rec(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function str(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

export function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}
