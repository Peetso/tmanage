'use client';

import Link from 'next/link';
import {
  COMPARE_CORRECTIONS_EMAIL,
  COMPARE_FEATURES,
  OURS,
  compareHref,
  isCompareStale,
  type CompareCell,
  type CompareEntry,
} from '../../../../content/compare/compare-entries';
import { compareCopy } from '../../../../content/compare/compare-copy';
import { localizeHref } from '../../../../lib/i18n/public-locale-routes';
import { SIGN_UP_HREF } from '../../../../lib/public-signup';
import { CtaBand, WebSection } from '../../sections';
import { useCompareLanguage } from './use-compare-language';
import './compare.css';

/**
 * Row 57-06 — one compare page (`/compare/<slug>`, `/ar/compare/<slug>`; Figma 608:34272 /
 * 608:34464, mobile 608:34616 / 608:34708): hero with the last-checked date and a correction link,
 * who each product suits, the side-by-side table (only rows confirmed on the competitor's site,
 * the price row linking their pricing page), their strengths, and the call to action.
 */
export function ComparePage({ entry }: { entry: CompareEntry }) {
  const language = useCompareLanguage();
  const copy = compareCopy(language);
  const date = copy.date(entry.checkedOn);
  const features = COMPARE_FEATURES.filter((feature) => entry.rows[feature] !== undefined);
  const href = (path: string) => (language === 'ar' ? localizeHref(path) : path);

  return (
    <>
      <WebSection className="tm-web-compare-hero" spacing="compact" aria-labelledby="compare-title">
        <div className="tm-web-compare-hero__inner">
          <p className="tm-web-compare-label">{copy.eyebrow}</p>
          <h1 id="compare-title" className="tm-web-compare-hero__title">
            {copy.title(entry.name)}
          </h1>
          <p className="tm-web-compare-hero__lede">{copy.lede}</p>
          <p className="tm-web-compare-hero__meta">
            <span data-testid="compare-last-checked">{copy.lastChecked(date)}</span>
            <span aria-hidden="true"> · </span>
            <a href={`mailto:${COMPARE_CORRECTIONS_EMAIL}`}>{copy.spotMistake}</a>
          </p>
          {isCompareStale(entry.checkedOn, new Date()) ? (
            <p className="tm-web-compare-stale" role="note">
              {copy.stale}
            </p>
          ) : null}
        </div>
      </WebSection>

      <WebSection spacing="flush" className="tm-web-compare-body">
        <div className="tm-web-compare-suits">
          <SuitsCard title={copy.suitsThem(entry.name)} items={entry.suits[language]} />
          <SuitsCard title={copy.suitsUs} items={copy.usSuits} />
        </div>

        <h2 id="compare-table-title" className="tm-web-compare-section-title">
          {copy.sideBySide}
        </h2>
        <table className="tm-web-compare-table" aria-labelledby="compare-table-title">
          <thead>
            <tr>
              <th scope="col">{copy.need}</th>
              <th scope="col">TManage</th>
              <th scope="col">{entry.name}</th>
            </tr>
          </thead>
          <tbody>
            {features.map((feature) => (
              <tr key={feature}>
                <th scope="row">{copy.features[feature]}</th>
                <td data-label="TManage">
                  <Mark tone="yes" text={OURS[feature][language]} />
                </td>
                <td data-label={entry.name}>
                  <TheirCell cell={entry.rows[feature]} language={language} />
                </td>
              </tr>
            ))}
            <tr>
              <th scope="row">{copy.price}</th>
              <td data-label="TManage">{OURS.price[language]}</td>
              <td data-label={entry.name}>
                <a href={entry.pricingUrl} rel="noopener nofollow" target="_blank">
                  {copy.seePricing(entry.name)}
                </a>
              </td>
            </tr>
          </tbody>
        </table>
        <p className="tm-web-compare-footnote">
          {copy.checkedNote(entry.name, date)}{' '}
          <a href={`mailto:${COMPARE_CORRECTIONS_EMAIL}`}>{COMPARE_CORRECTIONS_EMAIL}</a>{' '}
          {copy.fixIt} {copy.trademark(entry.name)}
        </p>

        <div className="tm-web-compare-cards">
          <InfoCard title={copy.strongTitle(entry.name)} body={entry.strong[language]} />
          <InfoCard title={copy.differentTitle} body={copy.different} />
          <InfoCard title={copy.movingTitle} body={copy.moving} />
        </div>
        <p className="tm-web-compare-all">
          <Link href={compareHref(undefined, language)}>{copy.allCompare}</Link>
        </p>
      </WebSection>

      <CtaBand
        title={copy.ctaTitle}
        lede={copy.ctaLede}
        primary={{ label: copy.ctaPrimary, href: href(SIGN_UP_HREF) }}
        secondary={{ label: copy.ctaSecondary, href: href('/contact') }}
        note=""
        visual={null}
      />
    </>
  );
}

function SuitsCard({ title, items }: { title: string; items: readonly string[] }) {
  return (
    <section className="tm-web-compare-suit">
      <h2 className="tm-web-compare-suit__title">{title}</h2>
      <ul>
        {items.map((item) => (
          <li key={item}>
            <span className="tm-web-compare-check" aria-hidden="true">
              ✓
            </span>
            {item}
          </li>
        ))}
      </ul>
    </section>
  );
}

function InfoCard({ title, body }: { title: string; body: string }) {
  return (
    <section className="tm-web-compare-card">
      <h3 className="tm-web-compare-card__title">{title}</h3>
      <p>{body}</p>
    </section>
  );
}

function Mark({ tone, text }: { tone: CompareCell['tone']; text: string }) {
  if (tone === 'note') return <>{text}</>;
  return (
    <span className={`tm-web-compare-mark tm-web-compare-mark--${tone}`}>
      <span aria-hidden="true">{tone === 'yes' ? '✓ ' : '— '}</span>
      {text}
    </span>
  );
}

function TheirCell({ cell, language }: { cell: CompareCell | undefined; language: 'en' | 'ar' }) {
  return cell === undefined ? null : <Mark tone={cell.tone} text={cell.text[language]} />;
}
