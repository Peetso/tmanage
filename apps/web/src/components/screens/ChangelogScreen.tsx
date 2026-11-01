'use client';

import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Announce, InlineAlert, LoadingRegion, Skeleton } from '@tmanage/ui';
import { browserApiClient } from '../../lib/api/browser-client';
import { getPublicChangelog } from '../../lib/api/public-changelog';
import type { PublicChangelogMonthRow } from '../../lib/api/public-changelog';
import { formatInstant } from '../../lib/work-item-presentation';
import { PublicIntro, PublicPage } from './public/PublicSite';
import type { ApiClient } from '../../lib/api/client';
import { useT } from '../../lib/i18n/use-t';
import type { MessageKey } from '../../lib/i18n/t';
import { useDescribeApiError } from '../../lib/api/describe-error';
import { appLocale } from '../../lib/i18n/app-locale';

export interface ChangelogScreenProps {
  client?: ApiClient;
}

/**
 * **Public changelog / product updates (x160).**
 *
 * `38-MODULE-MAP` §Public site (changelog) and the 2026-09-27 audit's rank #1 (Public site Missing —
 * no changelog). The public list of what shipped: every published product update, newest first,
 * grouped by the month it went live — each month a heading with its entries beneath it, so a
 * screen-reader user reads the same buckets a sighted reader sees.
 *
 * ## Public, and its own frame
 *
 * This is marketing-site content read before anyone signs in, so it uses neither `AppShell` (which
 * needs a tenant) nor an authenticated data path: `getPublicChangelog` calls the `@Public()` route
 * with `authentication: 'none'`. The landmarks — skip link, one `<main>`, one `<h1>` — are provided
 * here directly rather than by a shell, so `A11Y-01` (27-TEST-CATALOG) holds for a page that has no
 * shell of its own yet. It now sits in `PublicPage`, the shared public chrome.
 *
 * ## The body is shown as text, not rendered Markdown
 *
 * `body_md` is Markdown source. It reaches the DOM only as a React text node (never
 * `dangerouslySetInnerHTML`), with line breaks preserved — a rendered-Markdown surface is a later
 * refinement, and showing the source safely is strictly better than an injection risk.
 */
export function ChangelogScreen({ client }: ChangelogScreenProps) {
  const describeError = useDescribeApiError();
  const api = client ?? browserApiClient();
  const t = useT();

  const changelog = useQuery({
    queryKey: ['public-changelog'],
    queryFn: () => getPublicChangelog(api),
  });

  const months = useMemo<readonly PublicChangelogMonthRow[]>(
    () => changelog.data?.months ?? [],
    [changelog.data],
  );
  const entryCount = months.reduce((total, month) => total + month.entries.length, 0);

  // The loaded state is announced too, so the shell's live region ends on what the page now shows,
  // in the active language — not on the loading sentence (live report line 47).
  const loadedAnnouncement = changelog.isSuccess
    ? entryCount === 0
      ? t('ChangelogScreen.emptyTitle')
      : loadedCountText(t(LOADED_COUNT_KEY), entryCount)
    : '';

  return (
    <PublicPage>
      <div className="tm-pub-columns">
        <PublicIntro eyebrow={t('ChangelogScreen.eyebrow')} title={t('ChangelogScreen.title')}>
          <p className="tm-pub-lede tm-pub-lede--md">{t('ChangelogScreen.lede')}</p>
        </PublicIntro>

        <div className="tm-pub-stack">
          {changelog.isError ? (
            <InlineAlert tone="danger" title={t('ChangelogScreen.loadError')} live>
              {describeError(changelog.error)}
            </InlineAlert>
          ) : null}

          <Announce message={loadedAnnouncement} />

          {changelog.isPending ? (
            <LoadingRegion label={t('ChangelogScreen.loadingLabel')}>
              <Skeleton height="var(--row)" />
              <Skeleton height="var(--row)" />
              <Skeleton height="var(--row)" />
            </LoadingRegion>
          ) : null}

          {!changelog.isPending && !changelog.isError && months.length === 0 ? (
            <div className="tm-pub-card tm-pub-card--roomy tm-pub-card--dashed">
              <p className="tm-pub-card__title">{t('ChangelogScreen.emptyTitle')}</p>
              <p className="tm-pub-card__body">{t('ChangelogScreen.emptyBody')}</p>
            </div>
          ) : null}

          {months.map((month) => (
            <section
              key={month.month}
              className="tm-pub-stack"
              aria-labelledby={`tm-changelog-${month.month}`}
            >
              <h2 id={`tm-changelog-${month.month}`} className="tm-pub-eyebrow">
                {formatMonth(month.month)}
              </h2>
              <ul className="tm-pub-stack">
                {month.entries.map((entry) => (
                  <li key={entry.id} className="tm-pub-card tm-pub-card--roomy">
                    <div className="tm-pub-tags">
                      <span
                        className={`tm-pub-tag${entry.category === 'security' ? ' tm-pub-tag--warning' : ''}`}
                      >
                        {categoryLabel(entry.category)}
                      </span>
                      <span className="tm-pub-tag tm-pub-tag--mono">{entry.version}</span>
                    </div>
                    <h3 className="tm-pub-card__title">{entry.title}</h3>
                    <p className="tm-pub-card__eyebrow">
                      <time dateTime={entry.publishedAt}>{formatInstant(entry.publishedAt)}</time>
                    </p>
                    <div className="tm-pub-prose">{entry.bodyMd}</div>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      </div>
    </PublicPage>
  );
}

/** Arrives with the i18n-L9 fragment; cast until it is merged into en.json. */
const LOADED_COUNT_KEY = 'ChangelogScreen.loadedCount' as MessageKey;

/**
 * The "{count} updates" sentence. Until the fragment is merged the lookup falls back to the key
 * itself, and a key is never read to a screen-reader user — the empty string announces nothing.
 */
function loadedCountText(template: string, count: number): string {
  if (template === LOADED_COUNT_KEY) return '';
  return template.replace('{count}', String(count));
}

/** `YYYY-MM` → e.g. `September 2026`, in UTC so no reader's zone shifts the month. */
function formatMonth(month: string): string {
  const parsed = new Date(`${month}-01T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime())) return month;
  return new Intl.DateTimeFormat(appLocale(), {
    year: 'numeric',
    month: 'long',
    timeZone: 'UTC',
  }).format(parsed);
}

/** The category, as a short human label. */
function categoryLabel(category: 'feature' | 'fix' | 'security'): string {
  return category === 'fix' ? 'Fix' : category === 'security' ? 'Security' : 'Feature';
}
