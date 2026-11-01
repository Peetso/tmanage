'use client';

import { useId } from 'react';
import { useT } from '../../lib/i18n/use-t';

/**
 * **LocationHonestyNote** (Figma 504:29272) — the four limits shown wherever an IP location is:
 * the place is approximate, a VPN hides it, a MAC address never reaches a website, and a street
 * address comes only from the internet provider through the police.
 */
export function LocationHonestyNote({ compact = false }: { compact?: boolean }) {
  const t = useT();
  const titleId = useId();
  return (
    <aside
      className={`tm-intel-note${compact ? ' tm-intel-note--compact' : ''}`}
      aria-labelledby={titleId}
    >
      <p id={titleId} className="tm-intel-note__title">
        {t('LocationHonesty.title')}
      </p>
      <ul className="tm-intel-note__list">
        <li>{t('LocationHonesty.approximate')}</li>
        <li>{t('LocationHonesty.vpn')}</li>
        <li>{t('LocationHonesty.mac')}</li>
        <li>{t('LocationHonesty.street')}</li>
      </ul>
    </aside>
  );
}
