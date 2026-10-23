import type { Metadata } from 'next';
import { OfflineState } from '../../components/state/OfflineState';
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
 * connection returns. The words follow the active locale (`OfflineState`), and the bar carries
 * the language switch, since a signed-out visitor has no other way to pick Arabic here.
 */
export const metadata: Metadata = {
  title: 'Offline',
  description: 'TManage is offline and will reconnect when the network returns.',
};

export default function OfflinePage() {
  return (
    <StateScreen label="Offline" labelKey="StateScreens.labelOffline" languageSwitch>
      <OfflineState />
    </StateScreen>
  );
}
