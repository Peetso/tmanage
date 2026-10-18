'use client';

import Link from 'next/link';
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
  return (
    <div className="tm-web-featured">
      <p className="tm-web-featured__eyebrow">{featured.eyebrow}</p>
      <p className="tm-web-featured__title">{featured.title}</p>
      <p className="tm-web-featured__body">{featured.body}</p>
      <Link
        href={featured.href}
        className="tm-web-featured__link"
        {...(onNavigate ? { onClick: onNavigate } : {})}
      >
        <IconOrb icon={featured.icon} tone="lime" />
        <span>{featured.cta}</span>
      </Link>
    </div>
  );
}
