'use client';

import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { InlineAlert, LoadingRegion, Skeleton } from '@tmanage/ui';
import { browserApiClient } from '../../lib/api/browser-client';
import { getPublicChangelog } from '../../lib/api/public-changelog';
import type { PublicChangelogMonthRow } from '../../lib/api/public-changelog';
import { ApiRequestError, NetworkError } from '../../lib/api/errors';
import { formatInstant } from '../../lib/work-item-presentation';
import { PublicIntro, PublicPage } from './public/PublicSite';
import type { ApiClient } from '../../lib/api/client';

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
  const api = client ?? browserApiClient();

  const changelog = useQuery({
    queryKey: ['public-changelog'],
    queryFn: () => getPublicChangelog(api),
  });

  const months = useMemo<readonly PublicChangelogMonthRow[]>(
    () => changelog.data?.months ?? [],
    [changelog.data],
  );

  return (
    <PublicPage>
      <div className="tm-pub-columns">
        <PublicIntro eyebrow="Product · Changelog" title="What’s new">
          <p className="tm-pub-lede tm-pub-lede--md">
            Product updates, newest first. Grouped by the month each change went live.
          </p>
        </PublicIntro>

        <div className="tm-pub-stack">
          {changelog.isError ? (
            <InlineAlert tone="danger" title="Could not load the changelog" live>
              {describeError(changelog.error)}
            </InlineAlert>
          ) : null}

          {changelog.isPending ? (
            <LoadingRegion label="Loading the changelog.">
              <Skeleton height="var(--row)" />
              <Skeleton height="var(--row)" />
              <Skeleton height="var(--row)" />
            </LoadingRegion>
          ) : null}

          {!changelog.isPending && !changelog.isError && months.length === 0 ? (
            <div className="tm-pub-card tm-pub-card--roomy tm-pub-card--dashed">
              <p className="tm-pub-card__title">Nothing here yet</p>
              <p className="tm-pub-card__body">
                No product updates have been published. Check back soon.
              </p>
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

/** `YYYY-MM` → e.g. `September 2026`, in UTC so no reader's zone shifts the month. */
function formatMonth(month: string): string {
  const parsed = new Date(`${month}-01T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime())) return month;
  return new Intl.DateTimeFormat(undefined, {
    year: 'numeric',
    month: 'long',
    timeZone: 'UTC',
  }).format(parsed);
}

/** The category, as a short human label. */
function categoryLabel(category: 'feature' | 'fix' | 'security'): string {
  return category === 'fix' ? 'Fix' : category === 'security' ? 'Security' : 'Feature';
}

function describeError(error: unknown): string {
  if (error instanceof ApiRequestError) return error.message;
  if (error instanceof NetworkError) return 'The API did not answer. Is it running?';
  return 'Something went wrong. Try again.';
}
