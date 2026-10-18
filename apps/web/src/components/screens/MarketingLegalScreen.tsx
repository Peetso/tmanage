'use client';

import { useQuery } from '@tanstack/react-query';
import { InlineAlert, LoadingRegion, Skeleton } from '@tmanage/ui';
import { PublicIntro, PublicPage } from './public/PublicSite';
import { browserApiClient } from '../../lib/api/browser-client';
import { fetchPublicLegal } from '../../lib/api/public-legal';
import type { LegalDoc, PublicLegalView } from '../../lib/api/public-legal';
import { NetworkError } from '../../lib/api/errors';
import type { ApiClient } from '../../lib/api/client';

export interface MarketingLegalScreenProps {
  /** Which legal document to render — `terms` or `privacy`. Set by the thin route wrapper. */
  doc: LegalDoc;
  /** Injectable so a test drives a fake client; the browser gets the shared one. */
  client?: ApiClient;
}

/**
 * **Public legal page** — module 1 (x188), routed at `/legal/terms` and `/legal/privacy`.
 *
 * Read by a prospect or a customer's counsel before anyone signs in, so it is a public route: no
 * session, no organization, no capability. It renders the API's code-defined legal copy — a title,
 * an effective date, and long-form sections — with an in-page anchor nav so a reader can jump to a
 * clause.
 *
 * `PublicPage` owns the landmarks (skip link, banner, one `<main>`); this screen owns exactly one
 * `<h1>` and a labelled `<nav>` for the section index. `27-TEST-CATALOG`
 * A11Y-01, proved axe-clean.
 */
export function MarketingLegalScreen({ doc, client }: MarketingLegalScreenProps) {
  const api = client ?? browserApiClient();
  const legal = useQuery({
    queryKey: ['public-legal', doc],
    queryFn: () => fetchPublicLegal(api, doc),
    retry: false,
  });

  return (
    <PublicPage>
      {legal.isPending ? (
        <LoadingRegion label="Loading the document.">
          <Skeleton height="var(--row)" />
          <Skeleton height="var(--row)" />
          <Skeleton height="var(--row)" />
        </LoadingRegion>
      ) : legal.isError || !legal.data ? (
        <div className="tm-pub-columns">
          <PublicIntro eyebrow="Legal" title="Legal" />
          <InlineAlert tone="danger" title="This document could not be loaded" live>
            {legal.error instanceof NetworkError
              ? 'The API did not answer. Please try again shortly.'
              : 'Something went wrong loading this page. Please try again shortly.'}
          </InlineAlert>
        </div>
      ) : (
        <Content legal={legal.data} />
      )}
    </PublicPage>
  );
}

function Content({ legal }: { legal: PublicLegalView }) {
  return (
    <div className="tm-pub-columns">
      <div className="tm-pub-aside">
        <PublicIntro eyebrow="Legal" title={legal.title}>
          <p className="tm-pub-eyebrow">
            Effective <time dateTime={legal.effectiveDate}>{legal.effectiveDate}</time>
          </p>
          <p className="tm-pub-lede tm-pub-lede--md">{legal.intro}</p>
        </PublicIntro>

        <nav className="tm-pub-card tm-pub-toc" aria-label={`${legal.title} sections`}>
          <p className="tm-pub-card__eyebrow tm-pub-card__eyebrow--wide">On this page</p>
          <ul>
            {legal.sections.map((section) => (
              <li key={section.id}>
                <a href={`#${section.id}`}>{section.heading}</a>
              </li>
            ))}
          </ul>
        </nav>
      </div>

      <div className="tm-pub-stack">
        {legal.sections.map((section) => (
          <section
            key={section.id}
            id={section.id}
            className="tm-pub-card tm-pub-card--roomy tm-pub-section"
            aria-labelledby={`tm-legal-${section.id}`}
          >
            <h2 id={`tm-legal-${section.id}`} className="tm-pub-card__title">
              {section.heading}
            </h2>
            <p className="tm-pub-prose">{section.body}</p>
          </section>
        ))}
      </div>
    </div>
  );
}
