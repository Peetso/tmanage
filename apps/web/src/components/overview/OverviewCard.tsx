import Link from 'next/link';
import { useId, type ReactNode } from 'react';
import { NavIcon, type PhoneIconName } from '../icons/phone';

export interface OverviewCardProps {
  readonly title: string;
  /** The card's "Open …" link to its full screen; the whole header row is the hit area. */
  readonly link: { readonly href: string; readonly label: string };
  readonly children: ReactNode;
  /** Stable hook for tests and stories (`data-block`). */
  readonly block: string;
}

/**
 * ONEPAGE — one overview card (Figma "Card · …" in 739:40334): the card heading and its link on
 * one row, a hairline, then the block's figures and rows. The header row is the link's hit area
 * and at least 44 px high (review FIGMA-C fix 4), while the link alone carries the name.
 */
export function OverviewCard({ title, link, children, block }: OverviewCardProps) {
  const headingId = useId();
  return (
    <section className="tm-ov-card" aria-labelledby={headingId} data-block={block}>
      <div className="tm-ov-card__head">
        <h2 id={headingId} className="tm-ov-card__title">
          {title}
        </h2>
        <Link className="tm-ov-card__link" href={link.href}>
          {link.label}
        </Link>
      </div>
      {children}
    </section>
  );
}

/** The calm line a block with nothing in it keeps (review fix 7). */
export function OverviewEmpty({ children }: { readonly children: ReactNode }) {
  return <p className="tm-ov-card__empty">{children}</p>;
}

export interface OverviewFigure {
  readonly label: string;
  readonly value: string;
  readonly tone?: 'danger';
}

/** The row of big numbers (Figma "Figures"): the value above its label, label read first. */
export function OverviewFigures({ figures }: { readonly figures: readonly OverviewFigure[] }) {
  return (
    <dl className="tm-ov-figures">
      {figures.map((figure) => (
        <div key={figure.label} className="tm-ov-figures__item">
          <dt className="tm-ov-figures__label">{figure.label}</dt>
          <dd
            className="tm-ov-figures__value"
            {...(figure.tone ? { 'data-tone': figure.tone } : {})}
          >
            {figure.value}
          </dd>
        </div>
      ))}
    </dl>
  );
}

export interface OverviewRowProps {
  /** Plain text, or a sentence whose names sit in `<bdi>` (`OverviewCopy.isolated`, D10). */
  readonly title: ReactNode;
  readonly href: string;
  readonly meta?: ReactNode;
  /** The 40 px leading disc (a line icon); risk rows have none. */
  readonly leading?: ReactNode;
  /** The trailing capsule or badge. */
  readonly end?: ReactNode;
}

/** One list row of a block (Figma "Row"): disc, title link and meta, trailing capsule. */
export function OverviewRow({ title, href, meta, leading, end }: OverviewRowProps) {
  return (
    <li className="tm-ov-row">
      {leading ?? null}
      <span className="tm-ov-row__text">
        <Link className="tm-ov-row__title" href={href} dir="auto">
          {title}
        </Link>
        {meta ? (
          <span className="tm-ov-row__meta" dir="auto">
            {meta}
          </span>
        ) : null}
      </span>
      {end ? <span className="tm-ov-row__end">{end}</span> : null}
    </li>
  );
}

/**
 * D10: a meta line of separate facts ("Cedar Foods brand refresh · 2 days ago"), each in its own
 * `<bdi>` so a Latin project name and an Arabic age keep their order. Empty parts are dropped.
 */
export function isolatedParts(parts: readonly (string | undefined)[]): ReactNode {
  return parts
    .filter((part): part is string => part !== undefined && part !== '')
    .map((part, index) => (
      <span key={index}>
        {index > 0 ? ' · ' : null}
        <bdi>{part}</bdi>
      </span>
    ));
}

export function OverviewRows({ children }: { readonly children: ReactNode }) {
  return <ul className="tm-ov-rows">{children}</ul>;
}

/** The sunken 40 px disc with a 16 px line icon (Figma "Icon orb"). */
export function OverviewIconOrb({ icon }: { readonly icon: PhoneIconName }) {
  return (
    <span className="tm-ov-orb" aria-hidden="true">
      <NavIcon name={icon} size={16} />
    </span>
  );
}
