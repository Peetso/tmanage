'use client';

import { useTOr } from '../../lib/i18n/use-t-or';

/**
 * The offline fallback's panel, in the active locale.
 *
 * The same markup the offline route always rendered (the `tm-state` panel with one re-try
 * link), moved into a client component so its words follow `?lang=ar` and the language switch.
 * The English strings stay as the fallbacks, so the precached document still reads correctly
 * before hydration and while the keys are not in the catalogs.
 */
export function OfflineState() {
  const tOr = useTOr();
  return (
    <section className="tm-state" aria-labelledby="tm-offline-title" data-state="offline">
      <div className="tm-state__panel">
        <span className="tm-state__glyph" aria-hidden="true">
          ⊘
        </span>
        <div className="tm-state__text">
          <p className="tm-state__eyebrow" aria-hidden="true">
            {tOr('StateScreens.offlineEyebrow', 'Offline and reconnecting')}
          </p>
          <h1 id="tm-offline-title" className="tm-state__title">
            {tOr('StateScreens.offlineTitle', 'You’re offline')}
          </h1>
          <p className="tm-state__description">
            {tOr(
              'StateScreens.offlineDescription',
              'TManage can’t reach the network right now. Check your connection — the app reconnects on its own, or you can try again.',
            )}
          </p>
        </div>
        <div className="tm-state__actions">
          <a className="tm-button tm-button--ink tm-button--accessible" href="/">
            {tOr('StateScreens.offlineTryAgain', 'Try again')}
          </a>
        </div>
      </div>
    </section>
  );
}
