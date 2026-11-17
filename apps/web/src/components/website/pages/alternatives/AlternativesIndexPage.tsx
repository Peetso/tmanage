'use client';

import { LinkCard, SectionHeader, WebSection } from '../../sections';
import { ALTERNATIVE_COPY } from '../../../../content/alternatives/alternative-copy';
import {
  ALTERNATIVE_PAGES,
  ALTERNATIVES_UPDATED_ON,
} from '../../../../content/alternatives/alternative-entries';
import { useCompareLanguage } from '../compare/use-compare-language';
import { PublicPageHero } from './PublicPageHero';
import './alternatives.css';

/**
 * SEOF (B1) — the alternatives index (`/alternatives`, `/ar/alternatives`; Figma 687:14643 /
 * 687:14833, phone 687:15055 / 687:15185): the answer, then one card per alternative page and the
 * trademark note. Only pages that exist get a card.
 */
export function AlternativesIndexPage() {
  const language = useCompareLanguage();
  const copy = ALTERNATIVE_COPY[language];
  return (
    <>
      <PublicPageHero
        language={language}
        crumbs={[{ label: copy.alternatives }]}
        eyebrow={copy.alternatives}
        title={copy.indexTitle}
        lede={copy.indexLede}
        updatedOn={ALTERNATIVES_UPDATED_ON}
      />
      <WebSection aria-labelledby="alternatives-list">
        <SectionHeader
          id="alternatives-list"
          eyebrow={copy.listEyebrow}
          title={copy.listTitle}
          lede={copy.listLede}
        />
        <ul className="tm-web-alt-related">
          {ALTERNATIVE_PAGES.map(({ entry, rival }) => (
            <li key={entry.slug}>
              <LinkCard
                title={copy.cardTitle(rival.name)}
                hint={entry.category[language]}
                href={`/alternatives/${entry.slug}`}
              />
            </li>
          ))}
        </ul>
        <p className="tm-web-alt-note">{copy.indexNote}</p>
      </WebSection>
    </>
  );
}
