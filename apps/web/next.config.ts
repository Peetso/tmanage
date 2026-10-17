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
 * There is deliberately no Content-Security-Policy yet. A CSP written before the app has
 * its final asset origins is a CSP that gets loosened once and never tightened again; it
 * is recorded as an open item in `docs/implementation-status.md` instead of being guessed
 * at here. Every other header below is already correct at this stage.
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
  reactStrictMode: true,
  transpilePackages: ['@tmanage/ui'],
  poweredByHeader: false,

  async rewrites() {
    return [...publicConfig.rewrites];
  },

  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'X-Frame-Options', value: 'DENY' },
          {
            // No screen in this app needs a camera, a microphone, or a location.
            key: 'Permissions-Policy',
            value: 'camera=(), microphone=(), geolocation=(), interest-cohort=()',
          },
        ],
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
