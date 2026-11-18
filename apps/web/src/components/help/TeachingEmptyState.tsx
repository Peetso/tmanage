'use client';

import { useId } from 'react';
import type { ReactNode } from 'react';
import { findHelpArticle, helpHref } from '../../content/help/help-articles';
import { useHelpLanguage } from '../website/pages/help/use-help-language';
import './coach-marks.css';

/**
 * Row 55-10 — an empty state that teaches (Figma R49 L2, node 592:33601): a title, one line that
 * says what this list is for, one primary action, and a link to the Help centre article that
 * explains it, in the reader's language. The link is dropped if the article does not exist, so a
 * renamed article never leaves a dead link.
 */
export function TeachingEmptyState({
  title,
  explanation,
  action,
  helpSlug,
  helpLabel,
}: {
  readonly title: string;
  readonly explanation: string;
  /** The one primary action — a Link or Button the screen owns. */
  readonly action?: ReactNode;
  /** The Help centre article; leave out where none explains this screen. */
  readonly helpSlug?: string;
  readonly helpLabel?: string;
}) {
  const language = useHelpLanguage();
  const headingId = useId();
  const article = helpSlug === undefined ? undefined : findHelpArticle(helpSlug);
  return (
    <section className="tm-teach-empty" aria-labelledby={headingId}>
      <h2 id={headingId} className="tm-teach-empty__title">
        {title}
      </h2>
      <p className="tm-teach-empty__line">{explanation}</p>
      <div className="tm-teach-empty__actions">
        {action}
        {article === undefined || helpLabel === undefined ? null : (
          <a
            className="tm-teach-empty__help"
            href={helpHref(article.slug, language)}
            target="_blank"
            rel="noopener noreferrer"
            data-help-slug={article.slug}
          >
            {helpLabel}
          </a>
        )}
      </div>
    </section>
  );
}

/**
 * The usual primary action when the first step is a form on the same screen: focus its first field
 * a person can use. A disabled field cannot take focus, so it is skipped rather than swallowing it.
 */
export function focusFirstField(form: HTMLFormElement | null): void {
  form
    ?.querySelector<HTMLElement>(
      'input:not([type="hidden"]):not(:disabled), textarea:not(:disabled), select:not(:disabled)',
    )
    ?.focus();
}
