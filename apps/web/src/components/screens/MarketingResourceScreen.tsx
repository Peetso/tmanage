'use client';

import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { InlineAlert, LoadingRegion, Skeleton } from '@tmanage/ui';
import { PublicIntro, PublicPage } from './public/PublicSite';
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
    <PublicPage>
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
          <section className="tm-pub-columns" aria-labelledby="tm-resource-title">
            <div className="tm-pub-aside">
              <BackLink />
              <PublicIntro
                eyebrow="Resources"
                titleId="tm-resource-title"
                title="Resource not found"
              />
            </div>
            <div className="tm-pub-card tm-pub-card--roomy tm-pub-card--dashed">
              <p className="tm-pub-card__body tm-pub-card__body--md">
                We could not find that resource. It may have moved. Browse the{' '}
                <Link className="tm-pub-link" href="/resources">
                  full list of resources
                </Link>
                .
              </p>
            </div>
          </section>
        ) : (
          <div className="tm-pub-stack">
            <BackLink />
            <InlineAlert tone="danger" title="This resource could not load">
              {describeError(resource.error)}
            </InlineAlert>
          </div>
        )
      ) : (
        <article className="tm-pub-columns" aria-labelledby="tm-resource-title">
          <div className="tm-pub-aside">
            <BackLink />
            <PublicIntro
              eyebrow={resource.data.category}
              titleId="tm-resource-title"
              title={resource.data.title}
            >
              <p className="tm-pub-lede tm-pub-lede--md">{resource.data.summary}</p>
            </PublicIntro>
          </div>
          <div className="tm-pub-card tm-pub-card--roomy">
            <p className="tm-pub-prose">{resource.data.body}</p>
          </div>
        </article>
      )}
    </PublicPage>
  );
}

function BackLink() {
  return (
    <p>
      <Link className="tm-pub-btn tm-pub-btn--sm tm-pub-btn--quiet" href="/resources">
        &larr; All resources
      </Link>
    </p>
  );
}

/** The same honest error copy the authed screens use: a refusal reads differently from an outage. */
function describeError(error: unknown): string {
  if (error instanceof ApiRequestError) return error.message;
  if (error instanceof NetworkError)
    return 'We could not reach TManage. Check your connection and try again.';
  return 'Something went wrong loading this page. Please try again.';
}
