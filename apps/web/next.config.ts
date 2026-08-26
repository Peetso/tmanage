import type { NextConfig } from 'next';

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
 */
const config: NextConfig = {
  reactStrictMode: true,
  transpilePackages: ['@tmanage/ui'],
  poweredByHeader: false,

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
    ];
  },
};

export default config;
