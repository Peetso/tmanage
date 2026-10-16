import type { Metadata, Viewport } from 'next';
import localFont from 'next/font/local';
import type { ReactNode } from 'react';
import '@tmanage/ui/styles.css';
import './globals.css';
import { AuthBoundaryProvider } from '../components/providers/AuthBoundaryProvider';
import { QueryProvider } from '../components/providers/QueryProvider';
import { ServiceWorkerRegister } from '../components/pwa/ServiceWorkerRegister';
import { UpdateToast } from '../components/pwa/UpdateToast';

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

export const metadata: Metadata = {
  title: {
    default: 'TManage',
    template: '%s · TManage',
  },
  description: 'The work operating system for service teams and their clients.',
  // The screens behind sign-in are tenant data. None of them should ever be indexed, and
  // the public marketing pages (PUB-01 to PUB-07) are a separate ticket that can opt back in.
  robots: { index: false, follow: false },
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
 * The document.
 *
 * `lang` and `dir` are on `<html>` rather than on a provider element because they are
 * document-level facts: the browser uses them for hyphenation, quotation marks, form
 * controls and the scrollbar's side. `ThemeProvider` from `@tmanage/ui` exists for the
 * *nested* case — a client-portal preview rendered inside the internal app — and is
 * deliberately not used here.
 *
 * Arabic is not yet reachable: `42-INTERACTION-MOTION-RESPONSIVE-AND-RTL` requires a locale
 * negotiation this app does not have, and the Arabic face the tokens name (Alexandria) is
 * not packaged. `dir` is therefore `ltr` and the CSS throughout uses logical properties, so
 * the switch is a value change rather than a rewrite. Recorded as open in
 * `docs/implementation-status.md`.
 */
export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html
      lang="en"
      dir="ltr"
      className={manrope.variable}
      data-theme="light"
      data-density="balanced"
    >
      <body>
        <QueryProvider>
          <AuthBoundaryProvider>{children}</AuthBoundaryProvider>
        </QueryProvider>
        <ServiceWorkerRegister />
        {/* The service worker's "update available" affordance (slice 08): an always-mounted toast
            region that offers a reload when a new build is waiting to take over. */}
        <UpdateToast />
      </body>
    </html>
  );
}
