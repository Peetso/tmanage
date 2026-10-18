'use client';

import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { InlineAlert, LoadingRegion, Skeleton } from '@tmanage/ui';
import { PublicIntro, PublicPage } from './public/PublicSite';
import { browserApiClient } from '../../lib/api/browser-client';
import { fetchPublicFaq } from '../../lib/api/public-faq';
import type { PublicFaqView } from '../../lib/api/public-faq';
import { NetworkError } from '../../lib/api/errors';
import type { ApiClient } from '../../lib/api/client';

export interface MarketingFaqScreenProps {
  /** Injectable so a test drives a fake client; the browser gets the shared one. */
  client?: ApiClient;
}

/**
 * **Public FAQ page** — module 1 (x186), routed at `/faq`.
 *
 * Read by a prospect before anyone signs in, so it is a public route: no session, no organization,
 * no capability. It renders the API's code-defined FAQ content — grouped questions and answers — as
 * a native `<details>`/`<summary>` accordion, which is keyboard-operable and axe-clean without any
 * script. It states the copy; it reads nothing tenant-specific.
 *
 * `PublicPage` owns the landmarks (skip link, banner, one `<main>`); this screen owns exactly one
 * `<h1>`. `27-TEST-CATALOG` A11Y-01, proved axe-clean.
 */
export function MarketingFaqScreen({ client }: MarketingFaqScreenProps) {
  const api = client ?? browserApiClient();
  const faq = useQuery({
    queryKey: ['public-faq'],
    queryFn: () => fetchPublicFaq(api),
    retry: false,
  });

  return (
    <PublicPage>
      <div className="tm-pub-columns">
        <PublicIntro eyebrow="FAQ" title="Frequently asked questions">
          <p className="tm-pub-lede tm-pub-lede--md">
            Answers to the questions we hear most often about TManage, the client portal, and how
            your data is handled. For whether systems are up right now, see the{' '}
            <Link className="tm-pub-link" href="/status">
              status page
            </Link>
            .
          </p>
        </PublicIntro>

        <div className="tm-pub-stack">
          {faq.isPending ? (
            <LoadingRegion label="Loading the frequently asked questions.">
              <Skeleton height="var(--row)" />
              <Skeleton height="var(--row)" />
              <Skeleton height="var(--row)" />
            </LoadingRegion>
          ) : faq.isError || !faq.data ? (
            <InlineAlert tone="danger" title="This information could not be loaded" live>
              {faq.error instanceof NetworkError
                ? 'The API did not answer. Please try again shortly.'
                : 'Something went wrong loading this page. Please try again shortly.'}
            </InlineAlert>
          ) : (
            <Content faq={faq.data} />
          )}
        </div>
      </div>
    </PublicPage>
  );
}

function Content({ faq }: { faq: PublicFaqView }) {
  return (
    <>
      {faq.groups.map((group) => (
        <section
          key={group.id}
          className="tm-pub-card tm-pub-card--roomy"
          aria-labelledby={`tm-faq-${group.id}`}
        >
          <h2 id={`tm-faq-${group.id}`} className="tm-pub-card__eyebrow tm-pub-card__eyebrow--wide">
            {group.title}
          </h2>
          <div>
            {group.items.map((item) => (
              <details key={item.id} className="tm-pub-faq">
                <summary>{item.question}</summary>
                <p>{item.answer}</p>
              </details>
            ))}
          </div>
        </section>
      ))}
    </>
  );
}
