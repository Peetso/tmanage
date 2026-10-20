'use client';

import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { InlineAlert, LoadingRegion, Skeleton } from '@tmanage/ui';
import { PublicIntro, PublicPage } from './public/PublicSite';
import { browserApiClient } from '../../lib/api/browser-client';
import { fetchPublicResources } from '../../lib/api/public-resources';
import { ApiRequestError, NetworkError } from '../../lib/api/errors';
import type { ApiClient } from '../../lib/api/client';
import type { MessageKey } from '../../lib/i18n/t';
import { useT } from '../../lib/i18n/use-t';

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
  const t = useT();

  const resources = useQuery({
    queryKey: ['public-resources'],
    queryFn: () => fetchPublicResources(api),
  });

  return (
    <PublicPage>
      <section className="tm-pub-columns" aria-labelledby="tm-resources-title">
        <PublicIntro
          eyebrow={t('MarketingResourcesScreen.eyebrow')}
          titleId="tm-resources-title"
          title={t('MarketingResourcesScreen.title')}
        >
          <p className="tm-pub-lede tm-pub-lede--md">{t('MarketingResourcesScreen.lede')}</p>
        </PublicIntro>

        <div className="tm-pub-stack">
          {resources.isPending ? (
            <LoadingRegion label={t('MarketingResourcesScreen.loadingLabel')}>
              <div className="tm-stack">
                <Skeleton />
                <Skeleton />
                <Skeleton />
              </div>
            </LoadingRegion>
          ) : resources.isError ? (
            <InlineAlert tone="danger" title={t('MarketingResourcesScreen.errorTitle')}>
              {describeError(t, resources.error)}
            </InlineAlert>
          ) : resources.data.resources.length === 0 ? (
            <div className="tm-pub-card tm-pub-card--roomy tm-pub-card--dashed">
              <p className="tm-pub-card__title">{t('MarketingResourcesScreen.emptyTitle')}</p>
              <p className="tm-pub-card__body">{t('MarketingResourcesScreen.emptyBody')}</p>
            </div>
          ) : (
            <ul className="tm-pub-grid">
              {resources.data.resources.map((entry) => (
                <li key={entry.slug} className="tm-pub-card tm-pub-card--roomy">
                  <p className="tm-pub-card__eyebrow">{entry.category}</p>
                  <h2 className="tm-pub-card__title">
                    <Link className="tm-pub-link" href={`/resources/${entry.slug}`}>
                      {entry.title}
                    </Link>
                  </h2>
                  <p className="tm-pub-card__body tm-pub-card__body--md">{entry.summary}</p>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>
    </PublicPage>
  );
}

/** The same honest error copy the authed screens use: a refusal reads differently from an outage. */
function describeError(t: (key: MessageKey) => string, error: unknown): string {
  if (error instanceof ApiRequestError) return error.message;
  if (error instanceof NetworkError) return t('MarketingResourcesScreen.errorNetwork');
  return t('MarketingResourcesScreen.errorGeneric');
}
