'use client';

import Link from 'next/link';
import type { ReactNode } from 'react';
import { Avatar } from '@tmanage/ui';
import { WebIcon, type WebIconName } from './WebIcon';
import { ArrowLink, ButtonLink, Eyebrow, IconOrb, PlayCapsule, cx } from './primitives';
import { DeliveryRiskScene } from './ProductScenes';
import { SIGN_UP_HREF } from '../../lib/public-signup';
import { useT } from '../../lib/i18n/use-t';
import type { MessageKey } from '../../lib/i18n/t';

/* ── Web/Section — the 1248 column and section rhythm ─────────────────────────── */

export interface WebSectionProps {
  children: ReactNode;
  /** `canvas` paper/50 (default), `sunken` paper/150, `surface` paper/0, `ink` inverse. */
  tone?: 'canvas' | 'sunken' | 'surface' | 'ink';
  /** `default` = space/24 top and bottom; `compact` = space/16; `flush` = none. */
  spacing?: 'default' | 'compact' | 'flush';
  id?: string;
  className?: string;
  'aria-labelledby'?: string;
}

export function WebSection({
  children,
  tone = 'canvas',
  spacing = 'default',
  id,
  className,
  ...rest
}: WebSectionProps) {
  return (
    <section
      id={id}
      aria-labelledby={rest['aria-labelledby']}
      className={cx(
        'tm-web-section',
        `tm-web-section--${tone}`,
        `tm-web-section--${spacing}`,
        className,
      )}
    >
      <div className="tm-web-container">{children}</div>
    </section>
  );
}

/* ── Web/Section header ───────────────────────────────────────────────────────── */

export interface SectionHeaderProps {
  eyebrow?: string;
  title: ReactNode;
  lede?: ReactNode;
  link?: { label: string; href: string };
  align?: 'left' | 'center';
  /** `h2` (default) for sections; `h1` with `size="hero"`/`"page"` for a page hero. */
  as?: 'h1' | 'h2' | 'h3';
  /** `section` Heading/Page 36; `page` Display/LG 56; `hero` Display/XL 72. */
  size?: 'section' | 'page' | 'hero';
  tone?: 'paper' | 'ink';
  id?: string;
  children?: ReactNode;
}

export function SectionHeader({
  eyebrow,
  title,
  lede,
  link,
  align = 'left',
  as: Heading = 'h2',
  size = 'section',
  tone = 'paper',
  id,
  children,
}: SectionHeaderProps) {
  return (
    <header
      className={cx(
        'tm-web-header',
        `tm-web-header--${align}`,
        `tm-web-header--${size}`,
        tone === 'ink' && 'tm-web-header--ink',
      )}
    >
      {eyebrow ? <Eyebrow tone={tone}>{eyebrow}</Eyebrow> : null}
      <Heading id={id} className="tm-web-header__title">
        {title}
      </Heading>
      {lede ? <p className="tm-web-header__lede">{lede}</p> : null}
      {link ? (
        <ArrowLink href={link.href} tone={tone === 'ink' ? 'ink' : 'paper'}>
          {link.label}
        </ArrowLink>
      ) : null}
      {children}
    </header>
  );
}

/* ── Web/Stat and the stats band ──────────────────────────────────────────────── */

export interface StatProps {
  /** Product facts only — true by construction, never a usage claim. */
  value: string;
  unit?: string;
  label: string;
  note?: string;
}

export function Stat({ value, unit, label, note }: StatProps) {
  return (
    <div className="tm-web-stat">
      <span className="tm-web-stat__bar" aria-hidden="true" />
      <p className="tm-web-stat__figure">
        <span className="tm-web-stat__value">{value}</span>
        {unit ? <span className="tm-web-stat__unit">{unit}</span> : null}
      </p>
      <p className="tm-web-stat__label">{label}</p>
      {note ? <p className="tm-web-stat__note">{note}</p> : null}
    </div>
  );
}

export const PRODUCT_FACT_STATS: readonly StatProps[] = [
  {
    value: '1',
    unit: 'version',
    label: 'governed version per approval',
    note: 'Change the file and the approval is invalidated, not overwritten.',
  },
  {
    value: '10',
    unit: 'objects',
    label: 'linked in one work story',
    note: 'Request to evidence in one connected record.',
  },
  {
    value: '0',
    unit: 'seats',
    label: 'charged for client users',
    note: 'Clients join free and see only their allowlisted view.',
  },
  {
    value: '2',
    unit: 'languages',
    label: 'English and Arabic, right-to-left ready',
    note: 'One product, mirrored properly — not translated later.',
  },
];

/** Web/Stat row — four-up on the 1248 column, two-up on tablet, stacked on mobile. */
export function StatBand({ stats = PRODUCT_FACT_STATS }: { stats?: readonly StatProps[] }) {
  return (
    <div className="tm-web-stats">
      {stats.map((stat) => (
        <Stat key={`${stat.value}-${stat.unit ?? stat.label}`} {...stat} />
      ))}
    </div>
  );
}

/* ── Web/Logo strip ───────────────────────────────────────────────────────────── */

export interface LogoStripPartner {
  name: string;
  kind?: string;
  icon?: WebIconName;
}

/** The placeholder six: "Design partner 01…06" and their team type, read from the catalog. */
const DEFAULT_PARTNERS: readonly { kind: MessageKey; icon: WebIconName }[] = [
  { kind: 'HomePage.story1Team', icon: 'grid' },
  { kind: 'HomePage.partnerDesignStudio', icon: 'pencil' },
  { kind: 'HomePage.partnerConsultancy', icon: 'briefcase' },
  { kind: 'HomePage.partnerInhouse', icon: 'person' },
  { kind: 'HomePage.story1Team', icon: 'layers' },
  { kind: 'HomePage.partnerConsultancy', icon: 'trend' },
];

const partnerNumber = (index: number): string => String(index + 1).padStart(2, '0');

/**
 * Web/Logo strip — honest placeholders until partners approve their logos. `compact` is the
 * mono "DESIGN PARTNER · 01" capsule row; `detailed` adds an icon orb and the team type.
 */
export function LogoStrip({
  label,
  partners,
  variant = 'compact',
}: {
  label?: string;
  partners?: readonly LogoStripPartner[];
  variant?: 'compact' | 'detailed';
}) {
  const t = useT();
  const resolvedLabel = label ?? t('Sections.logoStripLabel');
  const partnerWord = t('HomePage.partnerKind');
  const shown: readonly LogoStripPartner[] =
    partners ??
    DEFAULT_PARTNERS.map((p, index) => ({
      name: `${partnerWord} ${partnerNumber(index)}`,
      kind: t(p.kind),
      icon: p.icon,
    }));
  return (
    <div className={cx('tm-web-logos', `tm-web-logos--${variant}`)}>
      <p className="tm-web-logos__label">{resolvedLabel}</p>
      <ul className="tm-web-logos__list">
        {shown.map((partner, index) => (
          <li key={partner.name} className="tm-web-logos__tile">
            {variant === 'compact' ? (
              <>
                <span className="tm-web-eyebrow__dot" aria-hidden="true" />
                <span className="tm-web-logos__mono">
                  {partnerWord} · {partnerNumber(index)}
                </span>
              </>
            ) : (
              <>
                <IconOrb icon={partner.icon ?? 'grid'} tone="lime" size="compact" />
                <span className="tm-web-logos__text">
                  <span className="tm-web-logos__name">{partner.name}</span>
                  {partner.kind ? <span className="tm-web-logos__kind">{partner.kind}</span> : null}
                </span>
              </>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

/* ── Testimonial card ─────────────────────────────────────────────────────────── */

export interface TestimonialCardProps {
  quote: string;
  /** The speaker's job title ("Studio lead"). Named `author`, not `role`, to stay clear of ARIA. */
  author: string;
  org: string;
  /** Initials for the avatar; design partners show "DP" until named. */
  initials?: string;
  tone?: 'paper' | 'ink';
  /** Honesty caption under every quote until a real, consented one exists. */
  note?: string | null;
}

export function TestimonialCard({
  quote,
  author,
  org,
  initials,
  tone = 'paper',
  note,
}: TestimonialCardProps) {
  const t = useT();
  const shownInitials = initials ?? t('Sections.testimonialInitials' as MessageKey);
  const resolvedNote = note === undefined ? t('Sections.testimonialNote') : note;
  return (
    <figure className={cx('tm-web-quote', tone === 'ink' && 'tm-web-quote--ink')}>
      <IconOrb icon="quote" tone="lime" />
      <blockquote className="tm-web-quote__text">
        <p>“{quote}”</p>
      </blockquote>
      <figcaption className="tm-web-quote__by">
        <Avatar name={shownInitials.split('').join(' ')} audience="client" decorative />
        <span className="tm-web-quote__who">
          <span className="tm-web-quote__role">{author}</span>
          <span className="tm-web-quote__org">{org}</span>
        </span>
      </figcaption>
      {resolvedNote ? <p className="tm-web-quote__note">{resolvedNote}</p> : null}
    </figure>
  );
}

/* ── Feature row (text + product visual, alternating) ─────────────────────────── */

export interface FeatureRowProps {
  /** The numbered call-out pin (1, 2, 3 …) shown before the label. */
  step?: number;
  label?: string;
  title: ReactNode;
  body: ReactNode;
  link?: { label: string; href: string };
  visual: ReactNode;
  /** Put the visual first (on the start side) — alternate rows for rhythm. */
  reverse?: boolean;
  id?: string;
  children?: ReactNode;
}

export function FeatureRow({
  step,
  label,
  title,
  body,
  link,
  visual,
  reverse = false,
  id,
  children,
}: FeatureRowProps) {
  return (
    <div className={cx('tm-web-feature', reverse && 'tm-web-feature--reverse')} id={id}>
      <div className="tm-web-feature__text">
        {step !== undefined || label ? (
          <p className="tm-web-feature__label">
            {step !== undefined ? <CalloutPin n={step} /> : null}
            {label ? <span>{label}</span> : null}
          </p>
        ) : null}
        <h3 className="tm-web-feature__title">{title}</h3>
        <p className="tm-web-feature__body">{body}</p>
        {children}
        {link ? (
          <ArrowLink href={link.href} underline={false}>
            {link.label}
          </ArrowLink>
        ) : null}
      </div>
      <ProductVisualFrame>{visual}</ProductVisualFrame>
    </div>
  );
}

/** The sunken radius/feature backdrop every product visual sits in. */
export function ProductVisualFrame({
  children,
  tone = 'sunken',
  className,
}: {
  children: ReactNode;
  tone?: 'sunken' | 'ink' | 'none';
  className?: string;
}) {
  return <div className={cx('tm-web-visual', `tm-web-visual--${tone}`, className)}>{children}</div>;
}

/* ── Link card ────────────────────────────────────────────────────────────────── */

export function LinkCard({ title, hint, href }: { title: string; hint?: string; href: string }) {
  return (
    <Link href={href} className="tm-web-link-card">
      <span className="tm-web-link-card__text">
        <span className="tm-web-link-card__title">{title}</span>
        {hint ? <span className="tm-web-link-card__hint">{hint}</span> : null}
      </span>
      <span className="tm-web-orb tm-web-orb--outline tm-web-orb--default" aria-hidden="true">
        <WebIcon name="arrow-right" size={14} />
      </span>
    </Link>
  );
}

/* ── FAQ / question row ───────────────────────────────────────────────────────── */

export interface FaqItem {
  question: string;
  answer: ReactNode;
}

export function FaqRow({
  question,
  answer,
  defaultOpen = false,
}: FaqItem & { defaultOpen?: boolean }) {
  return (
    <details className="tm-web-faq" open={defaultOpen}>
      <summary className="tm-web-faq__question">
        <span>{question}</span>
        <WebIcon name="plus" className="tm-web-accordion__plus" />
        <WebIcon name="minus" className="tm-web-accordion__minus" />
      </summary>
      <div className="tm-web-faq__answer">{answer}</div>
    </details>
  );
}

export function FaqList({ items }: { items: readonly FaqItem[] }) {
  return (
    <div className="tm-web-faq-list">
      {items.map((item) => (
        <FaqRow key={item.question} {...item} />
      ))}
    </div>
  );
}

/* ── Call-out pin ─────────────────────────────────────────────────────────────── */

/** The numbered lime pin that ties a feature row or caption to a spot on a product visual. */
export function CalloutPin({ n, label }: { n: number; label?: string }) {
  return (
    <span className="tm-web-pin" aria-label={label} aria-hidden={label ? undefined : true}>
      {n}
    </span>
  );
}

/* ── Graph card ───────────────────────────────────────────────────────────────── */

/** One facet of the work graph ("Identity — a stable ID and a home project"). */
export function GraphCard({
  icon = 'plus',
  title,
  body,
}: {
  icon?: WebIconName;
  title: string;
  body: string;
}) {
  return (
    <div className="tm-web-graph-card">
      <IconOrb icon={icon} tone="lime" />
      <h3 className="tm-web-graph-card__title">{title}</h3>
      <p className="tm-web-graph-card__body">{body}</p>
    </div>
  );
}

/* ── Web/CTA band ─────────────────────────────────────────────────────────────── */

export interface CtaBandProps {
  title?: ReactNode;
  lede?: ReactNode;
  primary?: { label: string; href: string };
  secondary?: { label: string; href: string };
  note?: string;
  /** The product-visual crop on the end side; pass `null` for a text-only band. */
  visual?: ReactNode | null;
}

export function CtaBand({ title, lede, primary, secondary, note, visual }: CtaBandProps) {
  const t = useT();
  const resolvedTitle = title ?? t('Sections.ctaTitle');
  const resolvedLede = lede ?? t('Sections.ctaLede');
  const resolvedPrimary = primary ?? { label: t('Sections.ctaPrimary'), href: SIGN_UP_HREF };
  const resolvedSecondary = secondary ?? {
    label: t('Sections.ctaSecondary'),
    href: '/#work-story',
  };
  const resolvedNote = note ?? t('Sections.ctaNote');
  const crop = visual === undefined ? <DeliveryRiskScene /> : visual;
  return (
    <section className="tm-web-cta-section" aria-label={t('Sections.getStarted')}>
      <div className="tm-web-container">
        <div className={cx('tm-web-cta', crop === null && 'tm-web-cta--text')}>
          <div className="tm-web-cta__text">
            <h2 className="tm-web-cta__title">{resolvedTitle}</h2>
            <p className="tm-web-cta__lede">{resolvedLede}</p>
            <div className="tm-web-cta__actions">
              <ButtonLink href={resolvedPrimary.href} tone="lime">
                {resolvedPrimary.label}
              </ButtonLink>
              <PlayCapsule href={resolvedSecondary.href} tone="paper">
                {resolvedSecondary.label}
              </PlayCapsule>
            </div>
            {resolvedNote ? <p className="tm-web-cta__note">{resolvedNote}</p> : null}
          </div>
          {crop !== null ? <div className="tm-web-cta__visual">{crop}</div> : null}
        </div>
      </div>
    </section>
  );
}
