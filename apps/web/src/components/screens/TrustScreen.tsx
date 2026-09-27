'use client';

import { useQuery } from '@tanstack/react-query';
import { InlineAlert, LiveAnnouncer, LoadingRegion, Skeleton, SkipLink } from '@tmanage/ui';
import { browserApiClient } from '../../lib/api/browser-client';
import { fetchPublicTrust } from '../../lib/api/public-trust';
import type { PublicTrustView } from '../../lib/api/public-trust';
import { NetworkError } from '../../lib/api/errors';
import type { ApiClient } from '../../lib/api/client';

export interface TrustScreenProps {
  /** Injectable so a test drives a fake client; the browser gets the shared one. */
  client?: ApiClient;
}

/**
 * **Public security & trust page** — module 1 (x158), routed at `/security`.
 *
 * Read by a prospect or a customer’s security reviewer before anyone signs in, so it is a
 * public route: no session, no organization, no capability. It renders the API’s
 * code-defined trust content — controls, data handling, subprocessors, compliance posture — and
 * links to the live status page (x159). It states the design; it does not report live status.
 *
 * The landmarks are the screen’s own here rather than a shared shell’s: a skip link, a
 * single `<main>`, exactly one `<h1>`. `27-TEST-CATALOG` A11Y-01, proved axe-clean.
 */
export function TrustScreen({ client }: TrustScreenProps) {
  const api = client ?? browserApiClient();
  const trust = useQuery({
    queryKey: ['public-trust'],
    queryFn: () => fetchPublicTrust(api),
    retry: false,
  });

  return (
    <LiveAnnouncer>
      <SkipLink targetId="tm-main" />
      <main id="tm-main" className="tm-public tm-stack" tabIndex={-1}>
        <header className="tm-stack tm-stack--tight">
          <p className="tm-eyebrow tm-mono">Security &amp; trust</p>
          <h1 className="tm-title">How TManage protects your data</h1>
          <p className="tm-prose">
            The controls the product is built to, the third parties it relies on, and how customer
            data is handled. This page describes the design; for whether systems are up right now,
            see the status page.
          </p>
        </header>

        {trust.isPending ? (
          <LoadingRegion label="Loading the security and trust information.">
            <Skeleton height="var(--row)" />
            <Skeleton height="var(--row)" />
            <Skeleton height="var(--row)" />
          </LoadingRegion>
        ) : trust.isError || !trust.data ? (
          <InlineAlert tone="danger" title="This information could not be loaded" live>
            {trust.error instanceof NetworkError
              ? 'The API did not answer. Please try again shortly.'
              : 'Something went wrong loading this page. Please try again shortly.'}
          </InlineAlert>
        ) : (
          <Content trust={trust.data} />
        )}
      </main>
    </LiveAnnouncer>
  );
}

function Content({ trust }: { trust: PublicTrustView }) {
  return (
    <>
      {trust.controls.map((section) => (
        <section
          key={section.id}
          className="tm-panel tm-stack"
          aria-labelledby={`tm-trust-${section.id}`}
        >
          <h2 id={`tm-trust-${section.id}`} className="tm-eyebrow">
            {section.title}
          </h2>
          <p className="tm-prose">{section.summary}</p>
          <ul className="tm-stack tm-stack--tight tm-list">
            {section.controls.map((control) => (
              <li key={control}>{control}</li>
            ))}
          </ul>
        </section>
      ))}

      <section className="tm-panel tm-stack" aria-labelledby="tm-trust-data">
        <h2 id="tm-trust-data" className="tm-eyebrow">
          Data handling
        </h2>
        <ul className="tm-stack tm-stack--tight tm-list">
          {trust.dataHandling.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      </section>

      <section className="tm-panel tm-stack" aria-labelledby="tm-trust-subprocessors">
        <h2 id="tm-trust-subprocessors" className="tm-eyebrow">
          Subprocessors
        </h2>
        <table className="tm-table" aria-label="Subprocessors that handle customer data">
          <thead>
            <tr>
              <th scope="col">Name</th>
              <th scope="col">Purpose</th>
              <th scope="col">Location</th>
            </tr>
          </thead>
          <tbody>
            {trust.subprocessors.map((sub) => (
              <tr key={sub.name}>
                <td>{sub.name}</td>
                <td>{sub.purpose}</td>
                <td>{sub.location}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="tm-panel tm-stack" aria-labelledby="tm-trust-compliance">
        <h2 id="tm-trust-compliance" className="tm-eyebrow">
          Compliance posture
        </h2>
        <ul className="tm-stack tm-stack--tight tm-list">
          {trust.compliance.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
        <p className="tm-prose">
          <a href={trust.statusPath}>See live system status</a>
        </p>
      </section>
    </>
  );
}
