'use client';

import { useQuery } from '@tanstack/react-query';
import { InlineAlert, LiveAnnouncer, LoadingRegion, Skeleton, SkipLink } from '@tmanage/ui';
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
 * The landmarks are the screen's own here rather than a shared shell's: a skip link, a single
 * `<main>`, exactly one `<h1>`, and a labelled `<nav>` for the section index. `27-TEST-CATALOG`
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
    <LiveAnnouncer>
      <SkipLink targetId="tm-main" />
      <main id="tm-main" className="tm-public tm-stack" tabIndex={-1}>
        {legal.isPending ? (
          <LoadingRegion label="Loading the document.">
            <Skeleton height="var(--row)" />
            <Skeleton height="var(--row)" />
            <Skeleton height="var(--row)" />
          </LoadingRegion>
        ) : legal.isError || !legal.data ? (
          <>
            <h1 className="tm-title">Legal</h1>
            <InlineAlert tone="danger" title="This document could not be loaded" live>
              {legal.error instanceof NetworkError
                ? 'The API did not answer. Please try again shortly.'
                : 'Something went wrong loading this page. Please try again shortly.'}
            </InlineAlert>
          </>
        ) : (
          <Content legal={legal.data} />
        )}
      </main>
    </LiveAnnouncer>
  );
}

function Content({ legal }: { legal: PublicLegalView }) {
  return (
    <>
      <header className="tm-stack tm-stack--tight">
        <p className="tm-eyebrow tm-mono">Legal</p>
        <h1 className="tm-title">{legal.title}</h1>
        <p className="tm-prose">
          Effective <time dateTime={legal.effectiveDate}>{legal.effectiveDate}</time>
        </p>
        <p className="tm-prose">{legal.intro}</p>
      </header>

      <nav className="tm-panel tm-stack tm-stack--tight" aria-label={`${legal.title} sections`}>
        <ul className="tm-stack tm-stack--tight tm-list">
          {legal.sections.map((section) => (
            <li key={section.id}>
              <a href={`#${section.id}`}>{section.heading}</a>
            </li>
          ))}
        </ul>
      </nav>

      {legal.sections.map((section) => (
        <section
          key={section.id}
          id={section.id}
          className="tm-panel tm-stack"
          aria-labelledby={`tm-legal-${section.id}`}
        >
          <h2 id={`tm-legal-${section.id}`} className="tm-eyebrow">
            {section.heading}
          </h2>
          <p className="tm-prose">{section.body}</p>
        </section>
      ))}
    </>
  );
}
