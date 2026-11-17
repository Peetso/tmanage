'use client';

import Link from '../../WebLink';
import { ButtonLink } from '../../primitives';
import { SectionHeader, WebSection } from '../../sections';
import { PUBLIC_HERO_COPY } from '../../../../content/alternatives/alternative-copy';
import type { CompareLanguage } from '../../../../content/compare/compare-entries';
import { SIGN_UP_HREF } from '../../../../lib/public-signup';
import './alternatives.css';

/** One step of the trail above the title; the last one (the page itself) has no link. */
export interface Crumb {
  readonly label: string;
  readonly href?: string;
}

/**
 * SEOF — the hero of the alternative pages and the facts page (Figma 685:13384 top, 687:15435
 * top): breadcrumb, eyebrow, the one H1, the answer in two sentences, "Start free" (and a second
 * outline button when given), the beta line and the "Last updated" date.
 */
export function PublicPageHero({
  language,
  crumbs,
  eyebrow,
  title,
  lede,
  secondary,
  updatedOn,
}: {
  language: CompareLanguage;
  crumbs: readonly Crumb[];
  eyebrow: string;
  title: string;
  lede: string;
  secondary?: { label: string; href: string };
  updatedOn: string;
}) {
  const copy = PUBLIC_HERO_COPY[language];
  return (
    <WebSection className="tm-web-alt-hero" spacing="compact" aria-labelledby="public-page-title">
      <nav className="tm-web-alt-crumbs" aria-label={copy.crumbLabel}>
        <ol>
          {[{ label: copy.home, href: '/' }, ...crumbs].map((crumb) => (
            <li key={crumb.label}>
              {crumb.href === undefined ? (
                <span aria-current="page">{crumb.label}</span>
              ) : (
                <Link href={crumb.href}>{crumb.label}</Link>
              )}
            </li>
          ))}
        </ol>
      </nav>
      <SectionHeader
        eyebrow={eyebrow}
        title={title}
        lede={lede}
        as="h1"
        size="page"
        id="public-page-title"
      >
        <div className="tm-web-alt-actions">
          <ButtonLink href={SIGN_UP_HREF} tone="lime">
            {copy.startFree}
          </ButtonLink>
          {secondary === undefined ? null : (
            <ButtonLink href={secondary.href} tone="outline">
              {secondary.label}
            </ButtonLink>
          )}
        </div>
        <p className="tm-web-alt-micro">{copy.micro}</p>
        <p className="tm-web-alt-updated" data-testid="public-page-updated">
          {copy.updated(copy.date(updatedOn))}
        </p>
      </SectionHeader>
    </WebSection>
  );
}
