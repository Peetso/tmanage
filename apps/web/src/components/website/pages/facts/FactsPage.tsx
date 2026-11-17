'use client';

import { CtaBand, SectionHeader, WebSection } from '../../sections';
import { FACTS_COPY, FACTS_UPDATED_ON, type FactRow } from '../../../../content/facts/facts';
import { useCompareLanguage } from '../compare/use-compare-language';
import { PublicPageHero } from '../alternatives/PublicPageHero';
import '../compare/compare.css';
import '../alternatives/alternatives.css';

/**
 * SEOF (B7) — the facts page (`/facts`, `/ar/facts`; Figma 687:15435 / 687:15669, phone
 * 687:15867 / 687:16043): the one description as the answer, the facts in one table, what TManage
 * does today, and the description again for writers to quote word for word.
 */
export function FactsPage({ website }: { website: string }) {
  const language = useCompareLanguage();
  const copy = FACTS_COPY[language];
  return (
    <>
      <PublicPageHero
        language={language}
        crumbs={[{ label: copy.crumb }]}
        eyebrow={copy.eyebrow}
        title={copy.title}
        lede={copy.description}
        updatedOn={FACTS_UPDATED_ON}
      />

      <WebSection aria-labelledby="facts-table">
        <SectionHeader id="facts-table" eyebrow={copy.tableEyebrow} title={copy.tableTitle} />
        <table className="tm-web-compare-table tm-web-alt-facts" aria-labelledby="facts-table">
          <tbody>
            {copy.rows(website).map((row) => (
              <tr key={row.label}>
                <th scope="row">{row.label}</th>
                <td>
                  <FactValue row={row} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </WebSection>

      <WebSection tone="sunken" aria-labelledby="facts-features">
        <SectionHeader
          id="facts-features"
          eyebrow={copy.featuresEyebrow}
          title={copy.featuresTitle}
        />
        <ul className="tm-web-alt-features">
          {copy.features.map((feature) => (
            <li key={feature}>
              <span className="tm-web-compare-check" aria-hidden="true">
                ✓
              </span>
              {feature}
            </li>
          ))}
        </ul>
      </WebSection>

      <WebSection aria-labelledby="facts-writers">
        <SectionHeader
          id="facts-writers"
          eyebrow={copy.writersEyebrow}
          title={copy.writersTitle}
          lede={copy.writersLede}
        />
        <blockquote className="tm-web-alt-quote">
          <p>{copy.description}</p>
        </blockquote>
      </WebSection>

      <CtaBand />
    </>
  );
}

function FactValue({ row }: { row: FactRow }) {
  if (row.link === 'website') {
    return (
      <a href={row.value} dir="ltr">
        {row.value}
      </a>
    );
  }
  if (row.link === 'email') {
    return (
      <a href={`mailto:${row.value}`} dir="ltr">
        {row.value}
      </a>
    );
  }
  return <>{row.value}</>;
}
