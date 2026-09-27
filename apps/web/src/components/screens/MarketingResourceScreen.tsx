'use client';

import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { InlineAlert, LiveAnnouncer, LoadingRegion, Skeleton, SkipLink } from '@tmanage/ui';
import { Wordmark } from '../brand/Wordmark';
import { browserApiClient } from '../../lib/api/browser-client';
import { fetchPublicResource } from '../../lib/api/public-resources';
import { ApiRequestError, NetworkError } from '../../lib/api/errors';
import type { ApiClient } from '../../lib/api/client';

export interface MarketingResourceScreenProps {
  /** The resource slug from the route. Looked up against the API's fixed catalog; unknown → 404. */
  slug: string;
  /** Injected in tests. Defaults to the browser client. */
  client?: ApiClient;
}

/**
 * **Marketing resource / guide article** — one resource from the public library (module 1, x187).
 *
 * Reads `GET /v1/public/site/resources/:slug`, a `@Public()` endpoint (no session, organization or
 * capability), and renders the article. A slug the API's fixed catalog does not name comes back a
 * 404, which this screen shows as an honest "not found" rather than an outage — the reader followed a
 * stale or mistyped link, not hit a broken service — with a way back to the index. As with the other
 * public screens the landmarks are built here (no tenant shell) and the content is API-driven so the
 * contract covers it.
 */
export function MarketingResourceScreen({ slug, client }: MarketingResourceScreenProps) {
  const api = client ?? browserApiClient();

  const resource = useQuery({
    queryKey: ['public-resource', slug],
    queryFn: () => fetchPublicResource(api, slug),
    retry: (failureCount, error) =>
      // A 404 is a definitive answer, not a transient failure — do not retry it.
      !(error instanceof ApiRequestError && error.status === 404) && failureCount < 3,
  });

  const notFound = resource.error instanceof ApiRequestError && resource.error.status === 404;

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
          <p>
            <Link href="/resources">&larr; All resources</Link>
          </p>

          {resource.isPending ? (
            <LoadingRegion label="Loading the article">
              <div className="tm-stack">
                <Skeleton />
                <Skeleton />
                <Skeleton />
              </div>
            </LoadingRegion>
          ) : resource.isError ? (
            notFound ? (
              <section className="tm-stack" aria-labelledby="tm-resource-title">
                <h1 id="tm-resource-title">Resource not found</h1>
                <p>
                  We could not find that resource. It may have moved. Browse the{' '}
                  <Link href="/resources">full list of resources</Link>.
                </p>
              </section>
            ) : (
              <InlineAlert tone="danger" title="This resource could not load">
                {describeError(resource.error)}
              </InlineAlert>
            )
          ) : (
            <article className="tm-stack" aria-labelledby="tm-resource-title">
              <p className="tm-marketing__eyebrow">{resource.data.category}</p>
              <h1 id="tm-resource-title">{resource.data.title}</h1>
              <p className="tm-marketing__lede">{resource.data.summary}</p>
              <p>{resource.data.body}</p>
            </article>
          )}
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
