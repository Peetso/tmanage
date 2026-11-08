'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { SearchField } from '@tmanage/ui';
import { ArrowLink, IconOrb } from '../../primitives';
import { CtaBand, WebSection } from '../../sections';
import {
  HELP_CATEGORIES,
  articlesIn,
  helpHref,
  type HelpArticle,
  type HelpLanguage,
} from '../../../../content/help/help-articles';
import { searchHelp } from '../../../../content/help/help-search';
import { helpCopy } from '../../../../content/help/help-copy';
import { useHelpLanguage } from './use-help-language';
import './help.css';

/**
 * Row 55-16 — the Help centre index (`/help`, `/ar/help`; Figma R35 L2-55-16): a centred hero with
 * the search field, then the seven topics with their articles. Typing searches every article in
 * both languages in the browser (Arabic-normalised) and replaces the topics with the results.
 */
export function HelpPage() {
  const language = useHelpLanguage();
  const copy = helpCopy(language);
  const [query, setQuery] = useState('');
  const results = useMemo(() => searchHelp(query), [query]);
  const searching = query.trim().length > 0;

  return (
    <>
      <WebSection className="tm-web-help-hero" aria-labelledby="help-title">
        <div className="tm-web-help-hero__inner">
          <p className="tm-web-help-label">{copy.eyebrow}</p>
          <h1 id="help-title" className="tm-web-help-hero__title">
            {copy.title}
          </h1>
          <p className="tm-web-help-hero__lede">{copy.lede}</p>
          <form
            className="tm-web-help-search"
            role="search"
            onSubmit={(event) => event.preventDefault()}
          >
            <SearchField
              label={copy.searchLabel}
              placeholder={copy.searchLabel}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              aria-controls="help-panel"
            />
          </form>
        </div>
      </WebSection>

      <WebSection spacing="flush" className="tm-web-help-body" aria-labelledby="help-panel-title">
        <div id="help-panel" className="tm-web-help-panel">
          {searching ? (
            <>
              <h2 id="help-panel-title" className="tm-web-help-section-title">
                {copy.resultsTitle}
              </h2>
              <p className="tm-web-help-count" aria-live="polite">
                {results.length > 0 ? copy.resultsCount(results.length) : ''}
              </p>
              {results.length > 0 ? (
                <ul className="tm-web-help-results">
                  {results.map((article) => (
                    <li key={article.slug}>
                      <ResultRow article={article} language={language} />
                    </li>
                  ))}
                </ul>
              ) : (
                <div className="tm-web-help-empty">
                  <IconOrb icon="search" tone="tint" />
                  <p className="tm-web-help-empty__title">{copy.emptyTitle}</p>
                  <p className="tm-web-help-empty__body">{copy.emptyBody}</p>
                  <ArrowLink href="/contact">{copy.contact}</ArrowLink>
                </div>
              )}
            </>
          ) : (
            <>
              <h2 id="help-panel-title" className="tm-web-help-section-title">
                {copy.browse}
              </h2>
              <ul className="tm-web-help-grid">
                {HELP_CATEGORIES.map((category) => {
                  const articles = articlesIn(category.id);
                  return (
                    <li key={category.id} id={`topic-${category.id}`} className="tm-web-help-topic">
                      <IconOrb icon={category.icon} tone="outline" />
                      <h3 className="tm-web-help-topic__title">{category.title[language]}</h3>
                      <p className="tm-web-help-topic__count">
                        {copy.articlesCount(articles.length)}
                      </p>
                      <ul className="tm-web-help-topic__list">
                        {articles.map((article) => (
                          <li key={article.slug}>
                            <Link
                              href={helpHref(article.slug, language)}
                              className="tm-web-help-link"
                            >
                              {article[language].title}
                            </Link>
                          </li>
                        ))}
                      </ul>
                    </li>
                  );
                })}
              </ul>
            </>
          )}
        </div>
      </WebSection>

      <CtaBand />
    </>
  );
}

function ResultRow({ article, language }: { article: HelpArticle; language: HelpLanguage }) {
  const copy = helpCopy(language);
  const category = HELP_CATEGORIES.find((c) => c.id === article.category);
  return (
    <article className="tm-web-help-result">
      <p className="tm-web-help-result__meta">
        {category?.title[language]} · {copy.minutes(article.minutes)}
      </p>
      <h3 className="tm-web-help-result__title">
        <Link href={helpHref(article.slug, language)} className="tm-web-help-link">
          {article[language].title}
        </Link>
      </h3>
      <p className="tm-web-help-result__summary">{article[language].summary}</p>
    </article>
  );
}
