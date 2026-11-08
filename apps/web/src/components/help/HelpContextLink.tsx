'use client';

import { useSyncExternalStore } from 'react';
import { findHelpArticle, helpHref } from '../../content/help/help-articles';
import { helpSlugForPath } from '../../content/help/help-context';
import { helpCopy } from '../../content/help/help-copy';
import { useHelpLanguage } from '../website/pages/help/use-help-language';
import './help-context-link.css';

function subscribe(onChange: () => void): () => void {
  window.addEventListener('popstate', onChange);
  return () => window.removeEventListener('popstate', onChange);
}

function readPath(): string {
  return window.location.pathname;
}

/**
 * Row 55-16 — the "?" beside a signed-in screen's title (Figma R35 L2-55-16, "In-app context
 * link"). It opens the Help centre article for this screen in a new tab, in the reader's language,
 * so the work in progress stays where it is. Screens without an article show nothing. `pathname`
 * overrides the address (tests, previews).
 */
export function HelpContextLink({ pathname }: { pathname?: string }) {
  // The address itself (not `usePathname`): the shell renders in many screens and harnesses, and
  // the server HTML carries no "?" so hydration never disagrees.
  const current = useSyncExternalStore(subscribe, readPath, () => undefined);
  const language = useHelpLanguage();
  const slug = helpSlugForPath(pathname ?? current);
  const article = slug === undefined ? undefined : findHelpArticle(slug);
  if (article === undefined) return null;
  const copy = helpCopy(language);
  const name = `${copy.contextLink}: ${article[language].title}`;
  return (
    <a
      className="tm-help-context-link"
      href={helpHref(article.slug, language)}
      target="_blank"
      rel="noopener noreferrer"
      title={name}
      aria-label={name}
      data-help-slug={article.slug}
    >
      <span aria-hidden="true">?</span>
    </a>
  );
}
