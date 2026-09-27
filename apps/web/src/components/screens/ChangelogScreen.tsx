'use client';

import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Badge, InlineAlert, LiveAnnouncer, LoadingRegion, Skeleton, SkipLink } from '@tmanage/ui';
import { browserApiClient } from '../../lib/api/browser-client';
import { getPublicChangelog } from '../../lib/api/public-changelog';
import type { PublicChangelogMonthRow } from '../../lib/api/public-changelog';
import { ApiRequestError, NetworkError } from '../../lib/api/errors';
import { formatInstant } from '../../lib/work-item-presentation';
import { Wordmark } from '../brand/Wordmark';
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
 * shell of its own yet. The sibling Public-site slices (home, pricing, trust — x156–x158) introduce
 * the shared marketing shell; this screen adopts it when it lands.
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
    <LiveAnnouncer>
      <div className="tm-identity">
        <SkipLink targetId="tm-main" />

        <div className="tm-identity__card">
          <header className="tm-identity__brand">
            <Wordmark />
            <p className="tm-identity__eyebrow tm-mono">Product · Changelog</p>
          </header>

          <main id="tm-main" className="tm-identity__body tm-stack" tabIndex={-1}>
            <h1 className="tm-identity__title">What&rsquo;s new</h1>
            <p className="tm-field__hint">
              Product updates, newest first. Grouped by the month each change went live.
            </p>

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
              <InlineAlert tone="neutral" title="Nothing here yet">
                No product updates have been published. Check back soon.
              </InlineAlert>
            ) : null}

            {months.map((month) => (
              <section
                key={month.month}
                className="tm-panel tm-stack"
                aria-labelledby={`tm-changelog-${month.month}`}
              >
                <h2 id={`tm-changelog-${month.month}`} className="tm-eyebrow">
                  {formatMonth(month.month)}
                </h2>
                <ul className="tm-stack tm-list">
                  {month.entries.map((entry) => (
                    <li key={entry.id} className="tm-stack">
                      <div className="tm-row tm-row--wrap">
                        <Badge>{categoryLabel(entry.category)}</Badge>
                        <Badge mono>{entry.version}</Badge>
                      </div>
                      <h3 className="tm-table__title">{entry.title}</h3>
                      <p className="tm-field__hint">
                        <time dateTime={entry.publishedAt}>{formatInstant(entry.publishedAt)}</time>
                      </p>
                      <div className="tm-prose">{entry.bodyMd}</div>
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </main>
        </div>
      </div>
    </LiveAnnouncer>
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
