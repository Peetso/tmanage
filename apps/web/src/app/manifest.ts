import type { MetadataRoute } from 'next';

/**
 * The web app manifest — the installable-shell contract for modules 22 (Desktop companion)
 * and 23 (Mobile companion).
 *
 * Next serves this file-convention route at `/manifest.webmanifest` and injects the
 * `<link rel="manifest">` into every document head automatically, so the root layout does
 * not hand-link it.
 *
 * ## Why a PWA and not Electron/Expo
 *
 * `38-MODULE-MAP` rows 22/23 want a window that "feels native" with its own updater, and
 * lists a native wrapper as a *later* decision (Needs-Peter / skipped). `display: standalone`
 * with `display_override: ['window-controls-overlay']` gives that standalone window — and, on
 * desktop, the title-bar overlay a companion app expects — with zero new runtime dependency.
 * The same installed shell serves both the desktop and the mobile companion; there is no fork
 * of the web app.
 *
 * ## Colours
 *
 * `theme_color` and `background_color` are the brand tokens from `@tmanage/ui`: `--ink-950`
 * (`#090a09`, the mark's own fill) paints the standalone title bar / window-controls overlay,
 * and `--paper-0` (`#ffffff`, the light canvas) is the splash background so the launch screen
 * matches the app's first paint.
 *
 * ## Icons
 *
 * The brand mark ships as SVG, which Chromium treats as installable with `sizes: 'any'`. A
 * second, square ink-on-lime variant carries `purpose: 'maskable'` so the adaptive-icon mask
 * on Android/desktop crops a padded safe zone rather than clipping the wordmark-less glyph.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    id: '/',
    name: 'TManage',
    short_name: 'TManage',
    description: 'The work operating system for service teams and their clients.',
    start_url: '/',
    scope: '/',
    display: 'standalone',
    display_override: ['window-controls-overlay'],
    theme_color: '#090a09',
    background_color: '#ffffff',
    // Quick capture (modules 22/23). The installed shell is the OS share target for text and links:
    // a GET share hands `title`/`text`/`url` to the capture route, which prefills the form from them
    // (see `buildCaptureDraft`). A `shortcut` puts the same capture one long-press away from the app
    // icon. Both point at `/capture`; the route is slug-scoped at `/{orgSlug}/capture`, and resolving
    // the slug-less landing to the caller's organization is deferred with the other "current org by
    // slug" gaps the app documents (no endpoint returns one organization by slug yet).
    share_target: {
      action: '/capture',
      method: 'GET',
      params: { title: 'title', text: 'text', url: 'url' },
    },
    shortcuts: [
      {
        name: 'Quick capture',
        short_name: 'Capture',
        description: 'File a note or task without leaving what you are doing.',
        url: '/capture',
      },
    ],
    icons: [
      {
        src: '/brand/tmanage-icon.svg',
        sizes: 'any',
        type: 'image/svg+xml',
        purpose: 'any',
      },
      {
        src: '/brand/tmanage-maskable.svg',
        sizes: 'any',
        type: 'image/svg+xml',
        purpose: 'maskable',
      },
    ],
  };
}
