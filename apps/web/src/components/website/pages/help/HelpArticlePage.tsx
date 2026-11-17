'use client';

import Link from 'next/link';
import { Badge } from '@tmanage/ui';
import { ButtonLink } from '../../primitives';
import { WebSection } from '../../sections';
import {
  findHelpArticle,
  findHelpCategory,
  helpHref,
  type HelpArticle,
  type HelpLanguage,
} from '../../../../content/help/help-articles';
import { helpCopy } from '../../../../content/help/help-copy';
import { switchLinksOfHelp } from '../../../../content/compare/compare-slugs';
import { localizeHref } from '../../../../lib/i18n/public-locale-routes';
import { useHelpLanguage } from './use-help-language';
import './help.css';

interface HelpLink {
  readonly href: string;
  readonly label: string;
}

/** A "Move your work from X" article links back to the switch and compare pages of X (SEOE). */
function switchBackLinks(slug: string, language: HelpLanguage): HelpLink[] {
  const switching = switchLinksOfHelp(slug);
  if (switching === undefined) return [];
  const copy = helpCopy(language);
  const href = (path: string) => (language === 'ar' ? localizeHref(path) : path);
  const links = [
    { href: href(`/switch/${switching.slug}`), label: copy.switchLink(switching.name) },
  ];
  if (switching.compareSlug !== undefined) {
    links.push({
      href: href(`/compare/${switching.compareSlug}`),
      label: copy.compareLink(switching.name),
    });
  }
  return links;
}

/**
 * Row 55-16 — one help article (`/help/<slug>`, `/ar/help/<slug>`; Figma R35 L2-55-16): breadcrumb,
 * topic badge and reading time, the title and summary, the body (paragraphs, numbered steps and a
 * tip), related articles and a way to reach support.
 */
export function HelpArticlePage({ article }: { article: HelpArticle }) {
  const language = useHelpLanguage();
  const copy = helpCopy(language);
  const text = article[language];
  const category = findHelpCategory(article.category);
  const related = article.related
    .map(findHelpArticle)
    .filter((a): a is HelpArticle => a !== undefined)
    .map((r): HelpLink => ({ href: helpHref(r.slug, language), label: r[language].title }));
  const links = [...switchBackLinks(article.slug, language), ...related];

  return (
    <WebSection className="tm-web-help-article" aria-labelledby="help-article-title">
      <div className="tm-web-help-article__inner">
        <nav className="tm-web-help-crumbs" aria-label={copy.breadcrumbLabel}>
          <Link href={helpHref(undefined, language)}>{copy.home}</Link>
          <span aria-hidden="true">/</span>
          <Link href={`${helpHref(undefined, language)}#topic-${category.id}`}>
            {category.title[language]}
          </Link>
        </nav>
        <p className="tm-web-help-article__meta">
          <Badge>{category.title[language]}</Badge>
          <span>{copy.minutes(article.minutes)}</span>
        </p>
        <h1 id="help-article-title" className="tm-web-help-article__title">
          {text.title}
        </h1>
        <p className="tm-web-help-article__summary">{text.summary}</p>

        <div className="tm-web-help-article__body">
          {text.body.map((block, i) => {
            if (block.kind === 'steps') {
              return (
                <ol key={i} className="tm-web-help-steps" aria-label={copy.stepsLabel}>
                  {block.items.map((item, n) => (
                    <li key={item}>
                      <span className="tm-web-help-steps__n" aria-hidden="true">
                        {n + 1}
                      </span>
                      <span>{item}</span>
                    </li>
                  ))}
                </ol>
              );
            }
            if (block.kind === 'tip') {
              return (
                <p key={i} className="tm-web-help-tip">
                  <strong>{copy.tip}: </strong>
                  {block.text}
                </p>
              );
            }
            return <p key={i}>{block.text}</p>;
          })}
        </div>

        {links.length > 0 ? (
          <aside className="tm-web-help-related" aria-labelledby="help-related-title">
            <h2 id="help-related-title" className="tm-web-help-related__title">
              {copy.related}
            </h2>
            <ul>
              {links.map((link) => (
                <li key={link.href}>
                  <Link href={link.href} className="tm-web-help-link">
                    {link.label}
                  </Link>
                </li>
              ))}
            </ul>
          </aside>
        ) : null}

        <div className="tm-web-help-stuck">
          <span>{copy.stuck}</span>
          <ButtonLink href="/contact" tone="outline" size="default">
            {copy.contact}
          </ButtonLink>
          <Link href={helpHref(undefined, language)} className="tm-web-help-link">
            {copy.allArticles}
          </Link>
        </div>
      </div>
    </WebSection>
  );
}
