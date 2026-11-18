'use client';

import { InlineAlert, StateCapsule } from '@tmanage/ui';
import {
  ARABIC_FIRST_COPY,
  USE_CASE_COPY,
  otherUseCases,
  type KitCard,
  type UseCaseEntry,
} from '../../../../content/arabic/arabic-pages';
import { arabicKitHref } from '../../../../content/arabic/arabic-slugs';
import type { CompareLanguage } from '../../../../content/compare/compare-entries';
import { SIGN_UP_HREF } from '../../../../lib/public-signup';
import { ButtonLink } from '../../primitives';
import { SectionHeader, WebSection } from '../../sections';
import { useCompareLanguage } from '../compare/use-compare-language';
import './arabic.css';

/**
 * Row 57-07 (MENA) — the Arabic-first product page (`/arabic`, `/ar/arabic`; Figma 725:39834 AR /
 * 725:39970 EN): hero, the three things it gives an agency, a drawing of the approval card, the
 * approval story as an ordered list (the right-to-left order comes from `dir`, not from reversed
 * markup), the region's pricing note, the use cases, help in Arabic and the beta line.
 */
export function ArabicFirstPage() {
  const language = useCompareLanguage();
  const copy = ARABIC_FIRST_COPY[language];
  const words = USE_CASE_COPY[language];
  return (
    <>
      <Hero
        eyebrow={copy.eyebrow}
        title={copy.title}
        lede={copy.lede}
        primary={copy.primary}
        secondary={{ label: copy.secondary, href: '#approval-story' }}
      />

      <WebSection spacing="flush" className="tm-web-arabic-body">
        <section className="tm-web-arabic-block" aria-labelledby="arabic-features">
          <h2 id="arabic-features" className="tm-visually-hidden">
            {copy.featuresLabel}
          </h2>
          <Cards cards={copy.features} />
        </section>

        <section className="tm-web-arabic-block" aria-labelledby="arabic-preview">
          <h2 id="arabic-preview" className="tm-web-arabic-title">
            {copy.previewTitle}
          </h2>
          <ApprovalPreview language={language} />
        </section>

        <section className="tm-web-arabic-block" aria-labelledby="approval-story">
          <h2 id="approval-story" className="tm-web-arabic-title">
            {copy.storyTitle}
          </h2>
          <Cards cards={copy.story} numbered />
        </section>

        <section className="tm-web-arabic-block" aria-labelledby="arabic-pricing">
          <h2 id="arabic-pricing" className="tm-web-arabic-title">
            {copy.pricingTitle}
          </h2>
          <div className="tm-web-arabic-text">
            {copy.pricing.map((line) => (
              <p key={line}>{line}</p>
            ))}
            <ButtonLink href="/pricing" tone="text" size="accessible">
              {copy.pricingLink}
            </ButtonLink>
          </div>
        </section>

        <section className="tm-web-arabic-block" aria-labelledby="arabic-use-cases">
          <h2 id="arabic-use-cases" className="tm-web-arabic-title">
            {copy.useCasesTitle}
          </h2>
          <UseCaseCards entries={otherUseCases()} language={language} readMore={words.readMore} />
        </section>

        <section className="tm-web-arabic-block" aria-labelledby="arabic-help">
          <h2 id="arabic-help" className="tm-web-arabic-title">
            {copy.helpTitle}
          </h2>
          <div className="tm-web-arabic-text">
            <p>{copy.helpLede}</p>
            <ButtonLink href="/help#topic-arabic" tone="text" size="accessible">
              {copy.helpLink}
            </ButtonLink>
          </div>
        </section>

        <InlineAlert tone="neutral">{copy.betaNote}</InlineAlert>
      </WebSection>
    </>
  );
}

/**
 * Row 57-07 (MENA) — one use-case page (`/arabic/<slug>`, `/ar/arabic/<slug>`; Figma 725:40234 AR
 * / 725:40106 EN): hero, before and after, how it works as an ordered list, the call to action,
 * its help article and the other use cases.
 */
export function ArabicUseCasePage({ entry }: { entry: UseCaseEntry }) {
  const language = useCompareLanguage();
  const text = entry[language];
  const words = USE_CASE_COPY[language];
  return (
    <>
      <Hero eyebrow={text.eyebrow} title={text.title} lede={text.lede} />

      <WebSection spacing="flush" className="tm-web-arabic-body">
        <section className="tm-web-arabic-block" aria-labelledby="use-case-before-after">
          <h2 id="use-case-before-after" className="tm-web-arabic-title">
            {words.beforeAfter}
          </h2>
          <Cards
            cards={[
              { title: words.before, body: text.before },
              { title: words.after, body: text.after },
            ]}
            columns="two"
          />
        </section>

        <section className="tm-web-arabic-block" aria-labelledby="use-case-how">
          <h2 id="use-case-how" className="tm-web-arabic-title">
            {words.how}
          </h2>
          <Cards cards={text.steps} numbered columns="four" />
        </section>

        <div className="tm-web-arabic-actions">
          <ButtonLink href={SIGN_UP_HREF} tone="ink" size="accessible">
            {words.primary}
          </ButtonLink>
          <ButtonLink href={`/help/${entry.helpSlug}`} tone="text" size="accessible">
            {words.help}
          </ButtonLink>
        </div>

        <section className="tm-web-arabic-block" aria-labelledby="use-case-more">
          <h2 id="use-case-more" className="tm-web-arabic-title">
            {words.more}
          </h2>
          <UseCaseCards
            entries={otherUseCases(entry.slug)}
            language={language}
            readMore={words.readMore}
            columns="two"
          />
        </section>
      </WebSection>
    </>
  );
}

function Hero({
  eyebrow,
  title,
  lede,
  primary,
  secondary,
}: {
  eyebrow: string;
  title: string;
  lede: string;
  primary?: string;
  secondary?: { label: string; href: string };
}) {
  return (
    <WebSection className="tm-web-arabic-hero" spacing="compact" aria-labelledby="arabic-title">
      <SectionHeader
        eyebrow={eyebrow}
        title={title}
        lede={lede}
        as="h1"
        size="page"
        id="arabic-title"
      >
        {primary === undefined ? null : (
          <div className="tm-web-arabic-actions">
            <ButtonLink href={SIGN_UP_HREF} tone="ink" size="accessible">
              {primary}
            </ButtonLink>
            {secondary === undefined ? null : (
              <ButtonLink href={secondary.href} tone="text" size="accessible">
                {secondary.label}
              </ButtonLink>
            )}
          </div>
        )}
      </SectionHeader>
    </WebSection>
  );
}

function Cards({
  cards,
  numbered = false,
  columns = 'three',
}: {
  cards: readonly KitCard[];
  numbered?: boolean;
  columns?: 'two' | 'three' | 'four';
}) {
  const List = numbered ? 'ol' : 'ul';
  const width = columns === 'three' ? '' : ` tm-web-arabic-cards--${columns}`;
  return (
    <List className={`tm-web-arabic-cards${width}`}>
      {cards.map((card, index) => (
        <li key={card.title} className="tm-web-arabic-card">
          {numbered ? (
            <span className="tm-web-arabic-card__step" aria-hidden="true">
              {index + 1}
            </span>
          ) : null}
          <h3 className="tm-web-arabic-card__title">{card.title}</h3>
          <p>{card.body}</p>
        </li>
      ))}
    </List>
  );
}

function UseCaseCards({
  entries,
  language,
  readMore,
  columns = 'three',
}: {
  entries: readonly UseCaseEntry[];
  language: CompareLanguage;
  readMore: string;
  columns?: 'two' | 'three';
}) {
  const width = columns === 'three' ? '' : ` tm-web-arabic-cards--${columns}`;
  return (
    <ul className={`tm-web-arabic-cards${width}`}>
      {entries.map((entry) => (
        <li key={entry.slug} className="tm-web-arabic-card">
          <h3 className="tm-web-arabic-card__title">{entry[language].name}</h3>
          <p>{entry[language].line}</p>
          <ButtonLink href={arabicKitHref(entry.slug)} tone="text" size="accessible">
            {readMore}
            <span className="tm-visually-hidden">: {entry[language].name}</span>
          </ButtonLink>
        </li>
      ))}
    </ul>
  );
}

/**
 * The approval card as the team sees it in the app (Figma 725:39935 / 725:40071): drawn, not
 * working, so it is hidden from assistive technology and described in one sentence instead.
 */
function ApprovalPreview({ language }: { language: CompareLanguage }) {
  const copy = ARABIC_FIRST_COPY[language];
  const card = copy.preview;
  return (
    <figure className="tm-web-arabic-preview">
      <div className="tm-web-arabic-preview__card" aria-hidden="true">
        <div className="tm-web-arabic-preview__row">
          <StateCapsule state="waiting">{card.state}</StateCapsule>
          <span className="tm-web-arabic-preview__since">{card.since}</span>
        </div>
        <span className="tm-web-arabic-preview__name">{card.name}</span>
        <span className="tm-web-arabic-preview__project">{card.project}</span>
        <span className="tm-web-arabic-preview__actions">
          <span className="tm-button tm-button--ink tm-button--accessible">{card.approve}</span>
          <span className="tm-button tm-button--outline tm-button--accessible">
            {card.sendBack}
          </span>
        </span>
      </div>
      <figcaption className="tm-visually-hidden">{copy.previewDescription}</figcaption>
    </figure>
  );
}
