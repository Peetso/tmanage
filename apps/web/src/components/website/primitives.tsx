'use client';

import Link from 'next/link';
import type { ReactNode } from 'react';
import { Wordmark } from '../brand/Wordmark';
import { WebIcon, type WebIconName } from './WebIcon';

/**
 * Website primitives (Website components §00) — the small parts every larger website component
 * is composed from. All paint comes from `website.css`, which reads only Limeframe tokens.
 */

const cx = (...parts: (string | false | null | undefined)[]) => parts.filter(Boolean).join(' ');

/** The brand lock-up: the ink tile carrying the lime TManage mark, then the name. */
export function BrandLockup({
  href = '/',
  tone = 'paper',
}: {
  href?: string;
  tone?: 'paper' | 'ink';
}) {
  return (
    <Link href={href} className={cx('tm-web-brand', tone === 'ink' && 'tm-web-brand--ink')}>
      <span className="tm-web-brand__tile" aria-hidden="true">
        <Wordmark variant="icon" label="" />
      </span>
      <span className="tm-web-brand__name">TManage</span>
    </Link>
  );
}

/** Mono caption eyebrow with the lime "current" dot. */
export function Eyebrow({
  children,
  tone = 'paper',
}: {
  children: ReactNode;
  tone?: 'paper' | 'ink';
}) {
  return (
    <p className={cx('tm-web-eyebrow', tone === 'ink' && 'tm-web-eyebrow--ink')}>
      <span className="tm-web-eyebrow__dot" aria-hidden="true" />
      {children}
    </p>
  );
}

export type IconOrbTone = 'outline' | 'ink' | 'lime' | 'tint';

/** Web/Icon orb — a round 40 px (or 32 px) disc around a Web/Icon. Decorative unless labelled. */
export function IconOrb({
  icon,
  tone = 'tint',
  size = 'default',
  className,
}: {
  icon: WebIconName;
  tone?: IconOrbTone;
  size?: 'compact' | 'default';
  className?: string;
}) {
  return (
    <span
      className={cx('tm-web-orb', `tm-web-orb--${tone}`, `tm-web-orb--${size}`, className)}
      aria-hidden="true"
    >
      <WebIcon name={icon} size={size === 'compact' ? 14 : 16} />
    </span>
  );
}

/**
 * Web/Play capsule — "Watch the work story". `ink` is the black capsule with the lime orb (hero
 * secondary on paper); `paper` is the white capsule for ink panels and quiet rows.
 */
export function PlayCapsule({
  href,
  children,
  tone = 'ink',
}: {
  href: string;
  children: ReactNode;
  tone?: 'ink' | 'paper';
}) {
  return (
    <Link href={href} className={cx('tm-web-play', `tm-web-play--${tone}`)}>
      <span className="tm-web-play__orb" aria-hidden="true">
        <WebIcon name="play" size={14} />
      </span>
      <span>{children}</span>
    </Link>
  );
}

/** Text link with the Web/Icon arrow ("Learn more →"). */
export function ArrowLink({
  href,
  children,
  tone = 'paper',
  underline = true,
}: {
  href: string;
  children: ReactNode;
  tone?: 'paper' | 'ink' | 'lime';
  underline?: boolean;
}) {
  return (
    <Link
      href={href}
      className={cx(
        'tm-web-arrow-link',
        tone !== 'paper' && `tm-web-arrow-link--${tone}`,
        !underline && 'tm-web-arrow-link--plain',
      )}
    >
      <span className="tm-web-arrow-link__label">{children}</span>
      <WebIcon name="arrow-right" size={14} />
    </Link>
  );
}

/** Web/Menu item — tinted icon tile, title, one-line hint. Used in mega menus and the drawer. */
export function MenuItem({
  href,
  icon,
  label,
  hint,
  onNavigate,
}: {
  href: string;
  icon: WebIconName;
  label: string;
  hint: string;
  onNavigate?: (() => void) | undefined;
}) {
  return (
    <Link href={href} className="tm-web-menu-item" {...(onNavigate ? { onClick: onNavigate } : {})}>
      <IconOrb icon={icon} size="compact" className="tm-web-menu-item__icon" />
      <span className="tm-web-menu-item__text">
        <span className="tm-web-menu-item__label">{label}</span>
        <span className="tm-web-menu-item__hint">{hint}</span>
      </span>
    </Link>
  );
}

/** Button-styled link built on the Limeframe `.tm-button` classes (packages/ui). */
export function ButtonLink({
  href,
  children,
  tone = 'lime',
  size = 'feature',
  className,
  onClick,
}: {
  href: string;
  children: ReactNode;
  tone?: 'lime' | 'ink' | 'outline' | 'text' | 'outline-ink';
  size?: 'compact' | 'default' | 'accessible' | 'feature';
  className?: string;
  onClick?: (() => void) | undefined;
}) {
  const base =
    tone === 'outline-ink' ? 'tm-button--outline tm-web-button--on-ink' : `tm-button--${tone}`;
  return (
    <Link
      href={href}
      {...(onClick ? { onClick } : {})}
      className={cx('tm-button', base, `tm-button--${size}`, 'tm-web-button', className)}
    >
      {children}
    </Link>
  );
}

export { cx };
