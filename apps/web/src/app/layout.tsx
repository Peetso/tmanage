import type { Metadata, Viewport } from 'next';
import localFont from 'next/font/local';
import type { ReactNode } from 'react';
import '@tmanage/ui/styles.css';
import './globals.css';
import '../styles/phone-tables.css';
import { AuthBoundaryProvider } from '../components/providers/AuthBoundaryProvider';
import { LocaleDirectionProvider } from '../components/providers/LocaleDirectionProvider';
import { QueryProvider } from '../components/providers/QueryProvider';
import { RouteDocumentTitle } from '../components/providers/RouteDocumentTitle';
import { ServiceWorkerRegister } from '../components/pwa/ServiceWorkerRegister';
import { UpdateToast } from '../components/pwa/UpdateToast';
import { LocaleHintToast } from '../components/shell/LocaleHintToast';
import { bootScripts } from '../lib/boot-scripts';
import { SITE_DESCRIPTION_EN } from '../lib/i18n/locale-html';
import { serverHtmlAttributes } from '../lib/i18n/server-html-attributes';

/**
 * Manrope, self-hosted.
 *
 * ## Why Manrope and not Satoshi
 *
 * The design export used both: `tokens.json` and `tokens.css` name Manrope as
 * `type.family.latin`, while the rendered `.dc.html` artboards set `font-family: Satoshi,
 * Manrope, system-ui` and use Satoshi for headings and controls with Manrope for prose. So
 * the two are not in conflict about which is the fallback — the artboards were drawn with a
 * pairing the token file does not describe.
 *
 * The question is settled by the licences rather than by taste. Manrope ships under the SIL
 * Open Font License 1.1, which permits redistribution and web use; its `OFL.txt` travels
 * beside the file in `src/fonts/`. Satoshi ships under the Fontshare EULA, whose §02 reads:
 *
 *   "You are not allowed to transmit the Font Software over the Internet in font serving or
 *    for font replacement by means of technologies such as but not limited to EOT, Cufon,
 *    sIFR or similar technologies that may be developed in the future without the prior
 *    written consent of the Licensor."
 *
 * Serving a `@font-face` from this application is font serving over the Internet. Without
 * written consent from the Indian Type Foundry, Satoshi cannot be self-hosted here at all,
 * so shipping it was never actually an option — and using it through the Fontshare API
 * instead would put a third-party origin in the critical path of the sign-in screen.
 *
 * Manrope therefore carries both roles, which is also what `--font-latin` in the packaged
 * tokens already says. If Peter later obtains a licence for Satoshi, the change is this file
 * and the `--font-latin` token, and the drift test will require the export's token to move
 * with it.
 *
 * ## Why `next/font/local` and not a `<link>`
 *
 * It self-hosts, so no request leaves for a font CDN — which matters on an identity screen,
 * where a third-party origin would see every sign-in attempt. `display: 'swap'` keeps text
 * readable while the file loads rather than hiding it.
 */
const manrope = localFont({
  src: '../fonts/Manrope-Variable.ttf',
  weight: '200 800',
  style: 'normal',
  display: 'swap',
  variable: '--font-manrope',
  // System stacks, in the order the export's own CSS gives them.
  fallback: ['system-ui', 'sans-serif'],
});

/**
 * The site-wide metadata. It is static on purpose: reading the request here (`cookies()`,
 * `headers()`) would make every route dynamic and stop the public pages being prerendered
 * (`deploy/hostinger/build.mjs` checks their `.html`, and the CDN caches them for 60 s). Each
 * route's own `title` fills the template; the brand name reads the same in both languages, and the
 * tab title follows the active locale in the browser (`RouteDocumentTitle`).
 */
export const metadata: Metadata = {
  title: {
    default: 'TManage',
    template: '%s · TManage',
  },
  description: SITE_DESCRIPTION_EN,
  // The screens behind sign-in are tenant data. None of them should ever be indexed, and
  // the public marketing pages (PUB-01 to PUB-07) are a separate ticket that can opt back in.
  robots: { index: false, follow: false },
  // The brand mark on the ink background (`public/brand/tmanage-maskable.svg`, rendered to PNG and
  // ICO). Static files in `public/`, so `/favicon.ico` is a real 200 instead of falling into the
  // `[orgSlug]` route; favicon lookups (browsers, and the Claude connector list) find the mark.
  icons: {
    icon: [
      { url: '/favicon.ico', sizes: '16x16 32x32 48x48' },
      { url: '/brand/tmanage-icon-32.png', type: 'image/png', sizes: '32x32' },
      { url: '/brand/tmanage-icon-192.png', type: 'image/png', sizes: '192x192' },
      { url: '/brand/tmanage-icon-512.png', type: 'image/png', sizes: '512x512' },
    ],
    shortcut: '/favicon.ico',
    apple: [{ url: '/apple-touch-icon.png', type: 'image/png', sizes: '180x180' }],
  },
};

export const viewport: Viewport = {
  // 40-DESIGN-SYSTEM §10 requires 200% zoom to reflow rather than clip, so nothing here
  // caps `maximum-scale` or sets `user-scalable=no`.
  width: 'device-width',
  initialScale: 1,
  // Paints the standalone window's title bar / window-controls overlay for the installed
  // PWA (modules 22/23). `--ink-950`, the brand mark's own fill. Next renders this as the
  // `<meta name="theme-color">`; the `<link rel="manifest">` is injected from `manifest.ts`.
  themeColor: '#090a09',
};

/**
 * Serialised once per server process; the same bytes in every static page. The Trusted Types
 * default policy first, then the locale boot (`lib/boot-scripts.ts`).
 */
const BOOT_SCRIPTS = bootScripts(process.env.NODE_ENV !== 'production');

/**
 * The document.
 *
 * `lang` and `dir` are on `<html>` rather than on a provider element because they are
 * document-level facts: the browser uses them for hyphenation, quotation marks, form
 * controls and the scrollbar's side. `ThemeProvider` from `@tmanage/ui` exists for the
 * *nested* case — a client-portal preview rendered inside the internal app — and is
 * deliberately not used here.
 *
 * `lang="en" dir="ltr"` with `data-theme="light"` is the prerendered baseline: correct with no
 * JavaScript and for every Latin-script member. The public pages stay static (shared hosting,
 * prerendered public pages, release no-go 70645c82), so `serverHtmlAttributes()` reads the request
 * only in a render that is per-request already (B17): a dynamic route's first HTML then carries
 * the `app/ar` route's or the saved cookie's `lang`/`dir` and the saved theme, with no flip after
 * hydration. On a prerendered page the tab's own locale is applied in
 * the browser: the inline `<head>` script from `locale-boot.ts` reads an allowlisted `?lang=`, the
 * saved-locale cookie the language switch writes, or the cached locale, and sets `lang`/`dir`
 * before the first paint; `LocaleDirectionProvider` (mounted just inside `<body>`) keeps them in
 * step whenever a member changes locale, so `ar-EG` reads right-to-left on reload and without one.
 * `suppressHydrationWarning` covers only `<html>`'s own attributes, which that script changes by
 * design. The script-src CSP (56-01, `src/proxy.ts`) allows these two inline scripts by SHA-256,
 * not by the per-request nonce: reading `headers()` here would make every route dynamic (see
 * `metadata` above). Their text must therefore stay exactly `bootScripts()`, which the proxy
 * hashes. The CSS throughout uses logical
 * properties, so that switch is a value change rather than a rewrite. The Arabic face the tokens
 * name (Alexandria) is self-hosted by `@font-face` in `globals.css` (R36), not here: it needs two
 * weight-range faces to carry the design's 500 → 400 mapping, which `localFont` cannot declare.
 */
export default async function RootLayout({ children }: { children: ReactNode }) {
  const html = await serverHtmlAttributes();
  return (
    <html
      lang={html.lang}
      dir={html.dir}
      className={manrope.variable}
      data-theme={html.theme}
      data-density="balanced"
      suppressHydrationWarning
    >
      <head>
        {BOOT_SCRIPTS.map((script, index) => (
          <script key={index} dangerouslySetInnerHTML={{ __html: script }} />
        ))}
      </head>
      <body>
        <QueryProvider>
          <LocaleDirectionProvider>
            <AuthBoundaryProvider>{children}</AuthBoundaryProvider>
          </LocaleDirectionProvider>
        </QueryProvider>
        {/* Every route's page name in the tab, in the active locale (`lib/route-titles.ts`). */}
        <RouteDocumentTitle />
        <ServiceWorkerRegister />
        {/* The service worker's "update available" affordance (slice 08): an always-mounted toast
            region that offers a reload when a new build is waiting to take over. */}
        <UpdateToast />
        {/* R12 R2: the first-visit language guess, applied once and announced (Change · Keep). */}
        <LocaleHintToast />
      </body>
    </html>
  );
}
