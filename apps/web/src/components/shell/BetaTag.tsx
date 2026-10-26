'use client';

import { useT } from '../../lib/i18n/use-t';
import './beta-tag.css';

/**
 * The open-beta tag beside the TManage logo in the app's top bars (Figma 419:9992, the Beta tag
 * component 10:57): a paper capsule with a quiet line, "BETA" in Geist Mono 12/17 — "تجريبي" in
 * Alexandria SemiBold in Arabic (419:23787).
 *
 * Always shown: the billing mode lives only on the API (plan usage and subscription reads), and the
 * whole product is in the open beta, so the shell does not make an extra read to decide it.
 *
 * `placement` picks the spot: `topbar` (Control Center bar, beside the brand orb), `rail` (under
 * the rail's brand orb on desktop) or `phone` (start of the phone top bar's organization line,
 * hidden from 768px where the rail carries it).
 */
export function BetaTag({ placement }: { placement: 'topbar' | 'rail' | 'phone' }) {
  const t = useT();
  return (
    <span className="tm-beta-tag" data-placement={placement}>
      {t('BetaBilling.badge')}
    </span>
  );
}
