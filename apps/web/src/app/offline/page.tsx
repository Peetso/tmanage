import type { Metadata } from 'next';
import { StateScreen } from '../../components/state/StateScreens';

/**
 * The offline fallback document.
 *
 * The service worker precaches this route and serves it when a navigation cannot reach the
 * network, so it must render as a plain, static document — no data fetch, no capability read.
 * It reuses the shared `StateScreen` frame (skip link, single `<main>`, live-region announcer)
 * and the design system's `tm-state` / `tm-button` classes, exactly as the 403/404/500 routes
 * do, rather than improvising its own layout.
 *
 * Being offline is not an error the person caused and not a dead end, so the copy is matter of
 * fact and the one action simply re-attempts the app root — which succeeds the moment the
 * connection returns.
 */
export const metadata: Metadata = {
  title: 'Offline',
  description: 'TManage is offline and will reconnect when the network returns.',
};

export default function OfflinePage() {
  return (
    <StateScreen>
      <section className="tm-state" aria-labelledby="tm-offline-title" data-state="offline">
        <div className="tm-state__panel">
          <span className="tm-state__glyph" aria-hidden="true">
            ⊘
          </span>
          <h1 id="tm-offline-title" className="tm-state__title">
            You’re offline
          </h1>
          <p className="tm-state__description">
            TManage can’t reach the network right now. Check your connection — the app reconnects on
            its own, or you can try again.
          </p>
          <div className="tm-state__actions">
            <a className="tm-button tm-button--ink tm-button--accessible" href="/">
              Try again
            </a>
          </div>
        </div>
      </section>
    </StateScreen>
  );
}
