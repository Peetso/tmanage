/**
 * The browser security policy (56-01) — the pure half. `src/proxy.ts` calls this on every page
 * request with a fresh nonce; nothing here reads the request, the clock or the environment, so the
 * whole policy is unit-tested (`tests/csp.test.ts`).
 *
 * ## The policy, and the four places it deliberately differs from the brief's sketch
 *
 * - `script-src 'self' 'nonce-…' 'strict-dynamic'` plus the locale boot script's hash. Next reads
 *   the nonce back out of the request's CSP header and stamps it on every script it renders itself;
 *   `strict-dynamic` lets those scripts load the chunks (and the Google Picker loader) they insert.
 *   The root layout's inline locale script is allowed by its SHA-256 instead of a nonce: reading
 *   the nonce there means `headers()` in the root layout, which would make every route dynamic and
 *   stop the public pages being prerendered (see the comment on `RootLayout`). Never
 *   `'unsafe-inline'` for scripts. In development only, `'unsafe-eval'` — React's dev build
 *   reconstructs server call stacks with `eval`; a production build never carries it.
 * - `style-src 'self' 'unsafe-inline'`, no nonce. The server-rendered markup carries `style="…"`
 *   attributes (81 `style={{…}}` props in `src/` today), and a nonce can never allow an attribute: CSP only offers `'unsafe-inline'` or
 *   per-value `'unsafe-hashes'` for those. A nonce in the list would also make browsers IGNORE
 *   `'unsafe-inline'`, so the two cannot be combined. Style injection cannot run script, which is
 *   why this is the accepted trade-off and the script half is not.
 * - `frame-src`, `connect-src`, `form-action` name the two cloud pickers' origins. The Google
 *   Picker is an iframe from Google and talks to googleapis; the OneDrive picker is a popup this
 *   page opens on `about:blank` (which inherits this policy) and POSTs a form into, to
 *   `onedrive.live.com` or the tenant's `*.sharepoint.com`. Without these the pickers break.
 *   `frame-src` also names Figma's embed host (R4 slice 13): the viewer's "Live" mode shows a
 *   Figma frame in an iframe. Nothing else from Figma is allowed (snapshots come from our API).
 * - Prerendered pages (B18) get `script-src 'self'` plus the SHA-256 of each inline script of
 *   their HTML instead of the nonce: built with no request, their scripts carry no nonce, and
 *   under `'strict-dynamic'` every one was reported. Still never `'unsafe-inline'`.
 * - `worker-src 'self'`. With `strict-dynamic`, `'self'` in `script-src` is ignored, and the
 *   service worker (`/sw.js`) falls back to `script-src`; it needs its own directive.
 *
 * When the browser reaches the API on another origin (development and the e2e harness:
 * `NEXT_PUBLIC_API_BASE_URL=http://localhost:3101`), that origin — and its `ws`/`wss` twin for the
 * realtime socket — joins `connect-src`, `img-src` and `media-src`. In production the API is
 * same-origin and nothing is added.
 */

/** Report-only first: the 7-day live soak (docs/runbooks/csp-enforcement.md), then `enforce`. */
export type CspMode = 'report-only' | 'enforce';

/** `CSP_MODE`: exactly `enforce` enforces; anything else (unset, a typo) stays report-only. */
export function resolveCspMode(value: string | undefined): CspMode {
  return value?.trim().toLowerCase() === 'enforce' ? 'enforce' : 'report-only';
}

/** Where browsers POST violation reports — answered by `apps/server/csp-report.mjs`. */
export const CSP_REPORT_PATH = '/csp-report';

/**
 * Trusted Types, report-only in this train by design: it names every DOM sink that receives a raw
 * string, so the enforcing step can be planned from real reports rather than guessed.
 */
export const TRUSTED_TYPES_REPORT_ONLY = `require-trusted-types-for 'script'; report-uri ${CSP_REPORT_PATH}`;

/** Avatars and file thumbnails from the two storage providers people connect (Drive, OneDrive). */
const IMAGE_ORIGINS = ['https://*.googleusercontent.com', 'https://*.sharepoint.com'];
const PICKER_FRAMES = ['https://docs.google.com', 'https://drive.google.com'];
/** R4 slice 13. The proofing viewer's "Live" mode embeds a Figma frame from Figma's embed host. */
const FIGMA_FRAMES = ['https://embed.figma.com', 'https://www.figma.com'];
const PICKER_CONNECT = ['https://apis.google.com', 'https://*.googleapis.com'];
const PICKER_FORMS = ['https://onedrive.live.com', 'https://*.sharepoint.com'];

/** 128 random bits as base64 — the nonce format Next's header parser accepts. */
export function nonceFromBytes(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** A Host header fit to go inside a policy: a hostname and an optional port, nothing else. */
function safeHost(host: string | undefined): string | undefined {
  return host !== undefined && /^[A-Za-z0-9.-]+(:\d{1,5})?$/.test(host) ? host : undefined;
}

/** An absolute http(s) API origin, or `undefined` for `same-origin` and anything unparsable. */
function crossOriginApi(apiBaseUrl: string | undefined): string | undefined {
  if (apiBaseUrl === undefined || !/^https?:\/\//i.test(apiBaseUrl)) return undefined;
  try {
    return new URL(apiBaseUrl).origin;
  } catch {
    return undefined;
  }
}

export interface CspInput {
  readonly nonce: string;
  /** The request's Host header — the realtime socket is same-host `wss:` (Safari wants it named). */
  readonly host?: string | undefined;
  /** `NEXT_PUBLIC_API_BASE_URL`; only an absolute origin changes the policy. */
  readonly apiBaseUrl?: string | undefined;
  /** `NODE_ENV !== 'production'`: adds `'unsafe-eval'` and the dev server's `ws:` HMR socket. */
  readonly development: boolean;
  /** `'sha256-…'` sources for the fixed inline scripts (the locale boot script). */
  readonly scriptHashes?: readonly string[];
  /**
   * B18. The page is served from build-time prerendered HTML, which carries no nonce: script-src
   * is then `'self'` plus `scriptHashes` (every inline script of that HTML), without the nonce and
   * without `'strict-dynamic'` — under which each of its ~17 chunk scripts was a violation.
   */
  readonly prerendered?: boolean;
  /**
   * 52-20. A public form page (`/f/:slug`) may be framed by the owner's own website (the embed
   * snippet), so its `frame-ancestors` is `'self' https:` instead of `'none'`. Every other page —
   * the consent and AI-approve pages included — stays unframeable.
   */
  readonly embeddable?: boolean;
}

/** 52-20. Only the public form page is embeddable. */
export function isEmbeddablePath(pathname: string): boolean {
  return /^\/f\/[^/]+\/?$/u.test(pathname);
}

function frameAncestors(input: { readonly embeddable?: boolean }): string {
  return input.embeddable === true ? "frame-ancestors 'self' https:" : "frame-ancestors 'none'";
}

/**
 * The text of every inline `<script>` in a page's HTML (those without `src`), exactly as the
 * browser hashes it. Pure; `lib/prerendered-script-hashes.ts` hashes the result.
 */
export function inlineScriptBodies(html: string): string[] {
  const bodies: string[] = [];
  for (const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)) {
    const attributes = match[1] ?? '';
    const body = match[2] ?? '';
    if (!/\ssrc\s*=/i.test(attributes) && body !== '') bodies.push(body);
  }
  return bodies;
}

/** The page policy itself, one string, directives in a fixed order. */
export function buildContentSecurityPolicy(input: CspInput): string {
  const host = safeHost(input.host);
  const api = crossOriginApi(input.apiBaseUrl);
  const apiSocket = api?.replace(/^http/i, 'ws');
  const sockets =
    host === undefined ? [] : [`wss://${host}`, ...(input.development ? [`ws://${host}`] : [])];
  const apiSources = api === undefined ? [] : [api];

  const directives: [string, ...string[]][] = [
    ['default-src', "'self'"],
    [
      'script-src',
      "'self'",
      ...(input.prerendered === true ? [] : [`'nonce-${input.nonce}'`, "'strict-dynamic'"]),
      ...[...new Set(input.scriptHashes ?? [])].map((hash) => `'${hash}'`),
      ...(input.development ? ["'unsafe-eval'"] : []),
    ],
    ['style-src', "'self'", "'unsafe-inline'"],
    ['img-src', "'self'", 'data:', 'blob:', ...IMAGE_ORIGINS, ...apiSources],
    ['media-src', "'self'", 'blob:', ...apiSources],
    [
      'connect-src',
      "'self'",
      ...sockets,
      ...apiSources,
      ...(apiSocket === undefined ? [] : [apiSocket]),
      ...PICKER_CONNECT,
    ],
    ['font-src', "'self'"],
    ['frame-src', "'self'", ...PICKER_FRAMES, ...FIGMA_FRAMES],
    ['worker-src', "'self'"],
    ['object-src', "'none'"],
    ['base-uri', "'self'"],
    ['form-action', "'self'", ...PICKER_FORMS],
    [frameAncestors(input)],
    ['report-uri', CSP_REPORT_PATH],
  ];
  return directives.map((parts) => parts.join(' ')).join('; ');
}

export interface PolicyHeaders {
  /** Set on the request Next renders, so the framework finds the nonce (and `x-nonce`). */
  readonly request: Readonly<Record<string, string>>;
  /** Set on the response; a name may repeat (two report-only policies), hence pairs. */
  readonly response: readonly (readonly [string, string])[];
}

/**
 * Every header the proxy sets for one page request.
 *
 * Report-only mode still ENFORCES `frame-ancestors 'none'` (S9/S10, clickjacking: the consent and
 * AI-approve pages must never be framed) — it moved here from `next.config.ts` so there is one
 * writer of `Content-Security-Policy` and the two can never race.
 */
export function policyHeaders(input: CspInput & { readonly mode: CspMode }): PolicyHeaders {
  const policy = buildContentSecurityPolicy(input);
  const name =
    input.mode === 'enforce' ? 'content-security-policy' : 'content-security-policy-report-only';
  const response: (readonly [string, string])[] = [[name, policy]];
  if (input.mode === 'report-only') {
    response.push(['content-security-policy', frameAncestors(input)]);
  }
  response.push(['content-security-policy-report-only', TRUSTED_TYPES_REPORT_ONLY]);
  return { request: { 'x-nonce': input.nonce, [name]: policy }, response };
}
