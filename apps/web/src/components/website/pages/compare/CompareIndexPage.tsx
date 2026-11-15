'use client';

import { COMPARE_ENTRIES, compareHref } from '../../../../content/compare/compare-entries';
import { compareCopy } from '../../../../content/compare/compare-copy';
import { LinkCard, WebSection } from '../../sections';
import { useCompareLanguage } from './use-compare-language';
import './compare.css';

/** Row 57-06 — the compare index (`/compare`, `/ar/compare`): one card per competitor page. */
export function CompareIndexPage() {
  const language = useCompareLanguage();
  const copy = compareCopy(language);
  return (
    <WebSection className="tm-web-compare-hero" aria-labelledby="compare-index-title">
      <div className="tm-web-compare-hero__inner">
        <p className="tm-web-compare-label">{copy.eyebrow}</p>
        <h1 id="compare-index-title" className="tm-web-compare-hero__title">
          {copy.indexTitle}
        </h1>
        <p className="tm-web-compare-hero__lede">{copy.indexLede}</p>
      </div>
      <ul className="tm-web-compare-index">
        {COMPARE_ENTRIES.map((entry) => (
          <li key={entry.slug}>
            <LinkCard
              title={copy.title(entry.name)}
              hint={copy.cardHint(copy.date(entry.checkedOn))}
              href={compareHref(entry.slug, language)}
            />
          </li>
        ))}
      </ul>
    </WebSection>
  );
}
