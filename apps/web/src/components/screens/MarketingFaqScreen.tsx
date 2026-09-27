'use client';

import { useQuery } from '@tanstack/react-query';
import { InlineAlert, LiveAnnouncer, LoadingRegion, Skeleton, SkipLink } from '@tmanage/ui';
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
 * The landmarks are the screen's own here rather than a shared shell's: a skip link, a single
 * `<main>`, exactly one `<h1>`. `27-TEST-CATALOG` A11Y-01, proved axe-clean.
 */
export function MarketingFaqScreen({ client }: MarketingFaqScreenProps) {
  const api = client ?? browserApiClient();
  const faq = useQuery({
    queryKey: ['public-faq'],
    queryFn: () => fetchPublicFaq(api),
    retry: false,
  });

  return (
    <LiveAnnouncer>
      <SkipLink targetId="tm-main" />
      <main id="tm-main" className="tm-public tm-stack" tabIndex={-1}>
        <header className="tm-stack tm-stack--tight">
          <p className="tm-eyebrow tm-mono">FAQ</p>
          <h1 className="tm-title">Frequently asked questions</h1>
          <p className="tm-prose">
            Answers to the questions we hear most often about TManage, the client portal, and how
            your data is handled. For whether systems are up right now, see the status page.
          </p>
        </header>

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
      </main>
    </LiveAnnouncer>
  );
}

function Content({ faq }: { faq: PublicFaqView }) {
  return (
    <>
      {faq.groups.map((group) => (
        <section
          key={group.id}
          className="tm-panel tm-stack"
          aria-labelledby={`tm-faq-${group.id}`}
        >
          <h2 id={`tm-faq-${group.id}`} className="tm-eyebrow">
            {group.title}
          </h2>
          <div className="tm-stack tm-stack--tight">
            {group.items.map((item) => (
              <details key={item.id} className="tm-disclosure">
                <summary className="tm-disclosure__summary">{item.question}</summary>
                <p className="tm-prose">{item.answer}</p>
              </details>
            ))}
          </div>
        </section>
      ))}
    </>
  );
}
