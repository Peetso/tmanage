/**
 * 52-21 — Cloudflare Turnstile verification (the free tier; no paid integration).
 *
 * The page renders the widget with `turnstile_site_key` and posts its token; the server asks
 * `siteverify` with `turnstile_secret` (both `platform_settings`; the secret is a 56-02 `fc1.`
 * FieldCipher envelope, decrypted by the caller). Three outcomes:
 *
 * - `pass` / `fail` — Cloudflare answered;
 * - `unavailable` — no answer within {@link TURNSTILE_TIMEOUT_MS}, a network error, a non-2xx, or
 *   Turnstile is not configured. The caller then **fails open to the e-mail code** (SEC-52-20): a
 *   Cloudflare outage must not lock people out, and must not let a script through either.
 */

export const TURNSTILE_VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
export const TURNSTILE_TIMEOUT_MS = 3_000;

export type TurnstileOutcome = 'pass' | 'fail' | 'unavailable';

export type FetchLike = (
  url: string,
  init: { method: string; body: URLSearchParams; signal: AbortSignal },
) => Promise<{ ok: boolean; json(): Promise<unknown> }>;

export interface TurnstileVerifyInput {
  readonly secret: string | null;
  readonly token: unknown;
  readonly remoteIp?: string | undefined;
  readonly fetchImpl?: FetchLike;
  readonly timeoutMs?: number;
}

export async function verifyTurnstile(input: TurnstileVerifyInput): Promise<TurnstileOutcome> {
  if (input.secret === null || input.secret === '') return 'unavailable';
  if (typeof input.token !== 'string' || input.token === '' || input.token.length > 2048) {
    return 'fail';
  }
  const body = new URLSearchParams({ secret: input.secret, response: input.token });
  if (input.remoteIp !== undefined && input.remoteIp !== '') body.set('remoteip', input.remoteIp);
  const fetchImpl = input.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
  const controller = new AbortController();
  const timeoutMs = input.timeoutMs ?? TURNSTILE_TIMEOUT_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<'unavailable'>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve('unavailable');
    }, timeoutMs);
  });
  const call = (async (): Promise<TurnstileOutcome> => {
    try {
      const response = await fetchImpl(TURNSTILE_VERIFY_URL, {
        method: 'POST',
        body,
        signal: controller.signal,
      });
      if (!response.ok) return 'unavailable';
      const data = (await response.json()) as { success?: unknown } | null;
      return data !== null && typeof data === 'object' && data.success === true ? 'pass' : 'fail';
    } catch {
      return 'unavailable';
    }
  })();
  try {
    return await Promise.race([call, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
