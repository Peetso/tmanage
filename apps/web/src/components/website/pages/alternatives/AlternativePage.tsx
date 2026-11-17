'use client';

import { ButtonLink } from '../../primitives';
import { CtaBand, FaqRow, LinkCard, SectionHeader, WebSection } from '../../sections';
import {
  ALTERNATIVE_COPY,
  PUBLIC_HERO_COPY,
} from '../../../../content/alternatives/alternative-copy';
import {
  ALTERNATIVE_PAGES,
  ALTERNATIVES_UPDATED_ON,
  type AlternativePage as AlternativePageData,
} from '../../../../content/alternatives/alternative-entries';
import {
  alternativeSources,
  alternativeTable,
  sourceLabel,
  type AlternativeTheirs,
} from '../../../../content/alternatives/alternative-table';
import { useCompareLanguage } from '../compare/use-compare-language';
import { PublicPageHero } from './PublicPageHero';
import '../compare/compare.css';
import './alternatives.css';

/**
 * SEOF (B1) — one "X alternative" page (`/alternatives/<slug>`, `/ar/alternatives/<slug>`; Figma
 * 685:13384 / 685:13685, phone 685:13974 / 685:14242): the answer, why teams look, the sourced
 * side-by-side table, what you keep and what changes, the questions (answers open in the HTML),
 * the related pages and the call to action.
 */
export function AlternativePage({ page }: { page: AlternativePageData }) {
  const language = useCompareLanguage();
  const copy = ALTERNATIVE_COPY[language];
  const { name, slug } = page.rival;
  const { fit } = page;
  const others = ALTERNATIVE_PAGES.filter((other) => other.rival.slug !== slug)
    .slice(0, 3)
    .map((other) => other.rival.name);

  return (
    <>
      <PublicPageHero
        language={language}
        crumbs={[{ label: copy.alternatives, href: '/alternatives' }, { label: name }]}
        eyebrow={copy.eyebrow(name)}
        title={copy.title(name)}
        lede={copy.lede(name)}
        secondary={{ label: copy.compareButton, href: `/compare/${slug}` }}
        updatedOn={ALTERNATIVES_UPDATED_ON}
      />

      <WebSection aria-labelledby="alternative-why">
        <SectionHeader
          id="alternative-why"
          eyebrow={copy.whyEyebrow}
          title={copy.whyTitle(name)}
          lede={page.entry.whyLede[language]}
        />
        <ol className="tm-web-alt-reasons">
          {copy.reasons(name, fit).map((reason, index) => (
            <li key={reason.title} className="tm-web-alt-card">
              <span className="tm-web-alt-card__number">{String(index + 1).padStart(2, '0')}</span>
              <h3 className="tm-web-alt-card__title">{reason.title}</h3>
              <p className="tm-web-alt-card__body">{reason.body}</p>
            </li>
          ))}
        </ol>
      </WebSection>

      <WebSection aria-labelledby="alternative-table" spacing="compact">
        <SectionHeader
          id="alternative-table"
          eyebrow={copy.tableEyebrow}
          title={copy.tableTitle(name)}
          lede={copy.tableLede(name)}
        />
        <table className="tm-web-compare-table" aria-labelledby="alternative-table">
          <thead>
            <tr>
              <th scope="col">{copy.need}</th>
              <th scope="col">TManage</th>
              <th scope="col">{name}</th>
            </tr>
          </thead>
          <tbody>
            {alternativeTable(page, language).map((row) => (
              <tr key={row.id} data-row={row.id}>
                <th scope="row">{row.label}</th>
                <td data-label="TManage">{row.ours}</td>
                <td data-label={name} data-testid={`theirs-${row.id}`}>
                  <Theirs theirs={row.theirs} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="tm-web-compare-footnote" data-testid="alternative-sources">
          {copy.checked(PUBLIC_HERO_COPY[language].date(page.rival.checkedOn))}
          <span aria-hidden="true"> · </span>
          {copy.sources}{' '}
          {alternativeSources(page).map((url, index) => (
            <span key={url}>
              {index === 0 ? null : <span aria-hidden="true"> · </span>}
              <a href={url} rel="noopener nofollow" target="_blank" dir="ltr">
                {sourceLabel(url)}
              </a>
            </span>
          ))}
        </p>
        <p className="tm-web-compare-footnote">{copy.trademark(name)}</p>
      </WebSection>

      <WebSection tone="sunken" aria-labelledby="alternative-switch">
        <SectionHeader
          id="alternative-switch"
          eyebrow={copy.switchEyebrow}
          title={copy.switchTitle}
          lede={copy.switchLede(name)}
        />
        <div className="tm-web-alt-keep">
          <CheckCard title={copy.keepTitle} items={copy.keep(page.entry.workWord)} />
          <CheckCard title={copy.changeTitle} items={copy.changes(fit)} />
        </div>
        {fit.hasSwitchPage ? (
          <div className="tm-web-alt-actions">
            <ButtonLink href={`/switch/${slug}`} tone="outline" size="default">
              {copy.switchButton(name)}
            </ButtonLink>
          </div>
        ) : null}
      </WebSection>

      <WebSection aria-labelledby="alternative-faq">
        <SectionHeader id="alternative-faq" eyebrow={copy.faqEyebrow} title={copy.faqTitle(name)} />
        <div className="tm-web-faq-list">
          {copy.faq(name, page.entry.workWord, fit).map((item) => (
            <FaqRow key={item.question} question={item.question} answer={item.answer} defaultOpen />
          ))}
        </div>
      </WebSection>

      <WebSection tone="sunken" aria-labelledby="alternative-related">
        <SectionHeader
          id="alternative-related"
          eyebrow={copy.relatedEyebrow}
          title={copy.relatedTitle}
        />
        <ul className="tm-web-alt-related">
          <li>
            <LinkCard
              title={copy.compareCard(name)}
              hint={copy.compareCardHint}
              href={`/compare/${slug}`}
            />
          </li>
          <li>
            {fit.hasSwitchPage ? (
              <LinkCard
                title={copy.switchCard(name)}
                hint={copy.switchCardHint}
                href={`/switch/${slug}`}
              />
            ) : (
              <LinkCard title={copy.portalCard} hint={copy.portalCardHint} href="/client-portal" />
            )}
          </li>
          <li>
            <LinkCard title={copy.allCard} hint={copy.allCardHint(others)} href="/alternatives" />
          </li>
        </ul>
      </WebSection>

      <CtaBand />
    </>
  );
}

function Theirs({ theirs }: { theirs: AlternativeTheirs }) {
  if (theirs.kind === 'pricing') {
    return (
      <a href={theirs.href} rel="noopener nofollow" target="_blank">
        {theirs.text}
      </a>
    );
  }
  if (theirs.kind === 'strong') {
    return (
      <>
        {theirs.text} <span className="tm-web-alt-ahead">· {theirs.ahead}</span>
      </>
    );
  }
  return <>{theirs.text}</>;
}

/** A card with a checked list (the compare pages' "may suit you if" card). */
export function CheckCard({ title, items }: { title: string; items: readonly string[] }) {
  return (
    <section className="tm-web-compare-suit">
      <h3 className="tm-web-compare-suit__title">{title}</h3>
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
