'use client';

import Link from 'next/link';
import { useT } from '../../lib/i18n/use-t';
import { IconOrb } from './primitives';
import type { WebFeatured } from './site-nav';

/** The ink featured card at the end of every mega menu — eyebrow, title, body, lime orb link. */
export function MegaMenuFeatured({
  featured,
  onNavigate,
}: {
  featured: WebFeatured;
  onNavigate?: (() => void) | undefined;
}) {
  const t = useT();
  return (
    <div className="tm-web-featured">
      <p className="tm-web-featured__eyebrow">{t(featured.eyebrow)}</p>
      <p className="tm-web-featured__title">{t(featured.title)}</p>
      <p className="tm-web-featured__body">{t(featured.body)}</p>
      <Link
        href={featured.href}
        className="tm-web-featured__link"
        {...(onNavigate ? { onClick: onNavigate } : {})}
      >
        <IconOrb icon={featured.icon} tone="lime" />
        <span>{t(featured.cta)}</span>
      </Link>
    </div>
  );
}
