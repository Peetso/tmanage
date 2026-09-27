'use client';

import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { InlineAlert, LiveAnnouncer, LoadingRegion, Skeleton, SkipLink } from '@tmanage/ui';
import { Wordmark } from '../brand/Wordmark';
import { browserApiClient } from '../../lib/api/browser-client';
import { fetchPublicResources } from '../../lib/api/public-resources';
import { ApiRequestError, NetworkError } from '../../lib/api/errors';
import type { ApiClient } from '../../lib/api/client';

export interface MarketingResourcesScreenProps {
  /** Injected in tests. Defaults to the browser client. */
  client?: ApiClient;
}

/**
 * **Marketing resources / guides index** — the public & trust site's resource library (module 1, x187).
 *
 * `38-MODULE-MAP` §Public & trust site: the sub-page a visitor reaches for guides and reference,
 * absent until now. It reads `GET /v1/public/site/resources`, a `@Public()` endpoint that needs no
 * session, no organization and no capability, and renders the index of cards it returns; each card
 * links to `/resources/[slug]`, the article view.
 *
 * Same two decisions as the marketing home: (1) no tenant, no auth — the landmarks (skip link,
 * `<main>`, one `<h1>`) are built here rather than borrowed from a shell that needs an organization;
 * (2) content comes from the API's `public-content` service, not baked into the page, so the API↔web
 * contract covers it and it degrades honestly — a skeleton while loading, an `InlineAlert` on failure.
 */
export function MarketingResourcesScreen({ client }: MarketingResourcesScreenProps) {
  const api = client ?? browserApiClient();

  const resources = useQuery({
    queryKey: ['public-resources'],
    queryFn: () => fetchPublicResources(api),
  });

  return (
    <LiveAnnouncer>
      <div className="tm-marketing">
        <SkipLink targetId="tm-main" />

        <header className="tm-marketing__bar tm-row tm-row--between">
          <Link href="/" aria-label="TManage home">
            <Wordmark />
          </Link>
          <nav aria-label="Primary">
            <Link className="tm-button tm-button--text tm-button--compact" href="/sign-in">
              Sign in
            </Link>
          </nav>
        </header>

        <main id="tm-main" className="tm-marketing__body" tabIndex={-1}>
          <section className="tm-stack" aria-labelledby="tm-resources-title">
            <h1 id="tm-resources-title">Resources &amp; guides</h1>
            <p className="tm-marketing__lede">
              Guides and reference for getting the most out of TManage.
            </p>

            {resources.isPending ? (
              <LoadingRegion label="Loading resources">
                <div className="tm-stack">
                  <Skeleton />
                  <Skeleton />
                  <Skeleton />
                </div>
              </LoadingRegion>
            ) : resources.isError ? (
              <InlineAlert tone="danger" title="These resources could not load">
                {describeError(resources.error)}
              </InlineAlert>
            ) : resources.data.resources.length === 0 ? (
              <InlineAlert tone="neutral" title="No resources yet">
                Check back soon — guides are on the way.
              </InlineAlert>
            ) : (
              <ul
                className="tm-marketing__features"
                style={{
                  display: 'grid',
                  gap: '1rem',
                  gridTemplateColumns: 'repeat(auto-fit, minmax(16rem, 1fr))',
                  listStyle: 'none',
                  margin: 0,
                  padding: 0,
                }}
              >
                {resources.data.resources.map((entry) => (
                  <li key={entry.slug} className="tm-card tm-stack tm-stack--tight">
                    <p className="tm-marketing__eyebrow">{entry.category}</p>
                    <h2>
                      <Link href={`/resources/${entry.slug}`}>{entry.title}</Link>
                    </h2>
                    <p>{entry.summary}</p>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </main>

        <footer className="tm-marketing__footer">
          <p>TManage — client work, without the status meeting.</p>
        </footer>
      </div>
    </LiveAnnouncer>
  );
}

/** The same honest error copy the authed screens use: a refusal reads differently from an outage. */
function describeError(error: unknown): string {
  if (error instanceof ApiRequestError) return error.message;
  if (error instanceof NetworkError)
    return 'We could not reach TManage. Check your connection and try again.';
  return 'Something went wrong loading this page. Please try again.';
}
