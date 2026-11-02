import type { NextConfig } from 'next';
import { validatePublicConfigForBuild } from './src/lib/public-config';
import { staticAssetHeaderRules } from './src/lib/static-headers';

/**
 * Next.js configuration.
 *
 * `transpilePackages` lists `@tmanage/ui` because that package ships its stylesheets as
 * raw CSS under `src/styles` — the build output in `dist/` is JavaScript only. Next has to
 * process the CSS itself rather than expect a pre-bundled artifact.
 *
 * The security headers below are the web half of `04-SECURITY-PRIVACY` §5. They are set
 * here rather than in a middleware because a header that ships with the response from the
 * framework itself cannot be skipped by a route that forgot to opt in.
 *
 * The Content-Security-Policy is NOT here (56-01): it carries a per-request nonce, so it is
 * set by `src/proxy.ts` (policy in `src/lib/csp.ts`, report-only until `CSP_MODE=enforce`,
 * see `docs/runbooks/csp-enforcement.md`). That includes the enforced `frame-ancestors 'none'`
 * the consent and AI-approve pages used to get from this file — one writer per header name.
 * HSTS and COOP are set here too so `next dev` (the e2e stack) shows them; the single-process
 * server adds the same values when a response arrives without them (`apps/server/boot-guards.mjs`).
 *
 * ## The public configuration is validated here, at load
 *
 * Review finding D19 (2026-09-05): a production build with no `NEXT_PUBLIC_API_BASE_URL`
 * compiled `http://localhost:3001` into every chunk and shipped. This runs before any route
 * compiles; a production build that would do that now stops in its first second with a
 * sentence naming the variable. In development the defaults stand — `next dev` sets
 * `NODE_ENV=development` and the resolver keeps `localhost:3001` there on purpose.
 *
 * ## Same-origin API (review finding D03)
 *
 * When `NEXT_PUBLIC_API_BASE_URL` is `same-origin`, `/v1/*` is rewritten to
 * `API_PROXY_TARGET`. The browser then sees one origin: the API's cookies are set on this
 * host, its readable CSRF cookie is readable by this page, and its path-scoped refresh cookie
 * is sent to the path it was scoped to. `50-BOOTSTRAP` §3's two applications remain two
 * applications; only the browser's view of them changes. See `public-config.ts`.
 */
const publicConfig = validatePublicConfigForBuild({
  nodeEnv: process.env.NODE_ENV,
  apiBaseUrl: process.env['NEXT_PUBLIC_API_BASE_URL'],
  sessionCookieName: process.env['NEXT_PUBLIC_SESSION_COOKIE_NAME'],
  apiProxyTarget: process.env['API_PROXY_TARGET'],
});

const config: NextConfig = {
  // The e2e harness boots its own `next dev` beside a developer's running one; two dev servers
  // cannot share one build directory, so the harness points this at its own (`.next-e2e`).
  distDir: process.env['TMANAGE_NEXT_DIST_DIR'] ?? '.next',
  reactStrictMode: true,
  transpilePackages: ['@tmanage/ui'],
  poweredByHeader: false,
  // The dev-only "N" route indicator sat on top of the public pages' content and showed up in
  // every design-review screenshot. Build and runtime errors still open the dev overlay.
  devIndicators: false,
  // `PUBLIC_SIGNUP` (the API's switch, default on) inlined for the website's links at build time:
  // `off` turns every "Start free" back into Sign in and hides "Create an account". The API's
  // routes follow the same variable at runtime, so a changed value needs a rebuild for the links.
  env: { NEXT_PUBLIC_SIGNUP: process.env['PUBLIC_SIGNUP'] ?? 'on' },

  // The short legal addresses an OAuth consent screen or a reader types (`/privacy`, `/terms`)
  // land on the real pages. Permanent (308), so crawlers and Google's brand review follow them.
  async redirects() {
    return [
      { source: '/privacy', destination: '/legal/privacy', permanent: true },
      { source: '/terms', destination: '/legal/terms', permanent: true },
      // A22: the same short addresses in Arabic, and `/communication` (the chat & calendar page's
      // short name). Without these `/communication` fell into `[orgSlug]` ("You no longer have
      // access") and `/ar/communication`, `/ar/privacy`, `/ar/terms` were the Arabic 404.
      { source: '/ar/privacy', destination: '/ar/legal/privacy', permanent: true },
      { source: '/ar/terms', destination: '/ar/legal/terms', permanent: true },
      { source: '/communication', destination: '/features/communication', permanent: true },
      {
        source: '/ar/communication',
        destination: '/ar/features/communication',
        permanent: true,
      },
    ];
  },

  async rewrites() {
    return [...publicConfig.rewrites];
  },

  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          // Public-link pages switch to `no-referrer` when 56-07 adds them (no route yet): a
          // share token in the URL must never leave in a Referer header.
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'X-Frame-Options', value: 'DENY' },
          {
            // No screen needs a camera or a location. The microphone is this origin's only, for
            // voice capture (55-20); no embedded frame may ask for it.
            key: 'Permissions-Policy',
            value: 'camera=(), microphone=(self), geolocation=(), interest-cohort=()',
          },
          // Same value as `apps/server/boot-guards.mjs` HSTS_VALUE (preload-eligible; the list
          // submission is optional, docs/runbooks/csp-enforcement.md). Ignored over plain http.
          {
            key: 'Strict-Transport-Security',
            value: 'max-age=31536000; includeSubDomains; preload',
          },
          // `same-origin-allow-popups`, not `same-origin`: the OneDrive picker is a popup this
          // page opens and talks to over postMessage; plain `same-origin` severs that opener.
          // Still no cross-origin page can keep a handle on a TManage window.
          { key: 'Cross-Origin-Opener-Policy', value: 'same-origin-allow-popups' },
        ],
      },
      // S9: the AI-app consent page decides what an outside app may do, so it is never framed
      // (threat model B2, clickjacking — the enforced `frame-ancestors 'none'` comes from
      // `src/proxy.ts`) and never cached.
      {
        source: '/connect/:path*',
        headers: [{ key: 'Cache-Control', value: 'no-store' }],
      },
      // S10: the AI approve page runs a confirm-class action on one click, so the same rule:
      // never framed (B2, clickjacking, `src/proxy.ts`), never cached.
      {
        source: '/:orgSlug/ai/approve/:id',
        headers: [{ key: 'Cache-Control', value: 'no-store' }],
      },
      // Long-lived caching for the content-hashed build assets (and the self-hosted font). The
      // catch-all rule above still matches these paths, so a static asset keeps the security
      // headers and gains `Cache-Control`. See `src/lib/static-headers.ts` for why `public/`,
      // HTML and `/v1/*` are deliberately excluded.
      ...staticAssetHeaderRules(),
    ];
  },
};

export default config;
