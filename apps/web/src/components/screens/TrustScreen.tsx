'use client';

import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { InlineAlert, LoadingRegion, Skeleton } from '@tmanage/ui';
import { PublicIntro, PublicPage } from './public/PublicSite';
import { browserApiClient } from '../../lib/api/browser-client';
import { fetchPublicTrust } from '../../lib/api/public-trust';
import type { PublicTrustView } from '../../lib/api/public-trust';
import { fetchPublicStatus } from '../../lib/api/public-site';
import type { PublicStatusView } from '../../lib/api/public-site';
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
  // PUB-05's dark status card reads the live public status rather than restating a number.
  const status = useQuery({
    queryKey: ['public-status'],
    queryFn: () => fetchPublicStatus(api),
    retry: false,
  });

  return (
    <PublicPage current="security">
      <section className="tm-pub-columns" aria-labelledby="tm-trust-title">
        <div className="tm-pub-aside">
          <PublicIntro
            eyebrow="Security & trust"
            titleId="tm-trust-title"
            size="sm"
            title="Two tenants can never see each other."
          >
            <p className="tm-pub-lede tm-pub-lede--md">
              Isolation is enforced in the database, not in the interface. Every request is bound to
              one organization and checked before any handler runs. This page describes the design;
              for whether systems are up right now, see the status page.
            </p>
          </PublicIntro>
          <div className="tm-pub-btn-row">
            <a className="tm-pub-btn tm-pub-btn--sm tm-pub-btn--quiet" href="#tm-trust-controls">
              Architecture overview
            </a>
            <Link className="tm-pub-btn tm-pub-btn--sm tm-pub-btn--ink" href="/contact">
              Request the security pack
            </Link>
          </div>
        </div>

        <div className="tm-pub-stack">
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
            <Content trust={trust.data} status={status.data} />
          )}
        </div>
      </section>

      <AccessibilitySection />
    </PublicPage>
  );
}

function Content({
  trust,
  status,
}: {
  trust: PublicTrustView;
  status: PublicStatusView | undefined;
}) {
  const overall = status ? OVERALL[status.overall] : undefined;
  const lastIncident = status?.incidents?.[0];

  return (
    <>
      <ul id="tm-trust-controls" className="tm-pub-grid">
        {trust.controls.map((section) => (
          <li key={section.id} className="tm-pub-card">
            <h2 id={`tm-trust-${section.id}`} className="tm-pub-card__eyebrow">
              {section.title}
            </h2>
            <p className="tm-pub-card__title tm-pub-card__title--sm">{section.summary}</p>
            <ul className="tm-pub-card__list">
              {section.controls.map((control) => (
                <li key={control}>{control}</li>
              ))}
            </ul>
          </li>
        ))}
      </ul>

      <div className="tm-pub-trust-lower">
        <div className="tm-pub-stack">
          <section className="tm-pub-card" aria-labelledby="tm-trust-subprocessors">
            <h2
              id="tm-trust-subprocessors"
              className="tm-pub-card__eyebrow tm-pub-card__eyebrow--wide"
            >
              Subprocessors
            </h2>
            <table className="tm-pub-table" aria-label="Subprocessors that handle customer data">
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
                    <td className="tm-pub-table__meta">{sub.location}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>

          <section className="tm-pub-card" aria-labelledby="tm-trust-data">
            <h2 id="tm-trust-data" className="tm-pub-card__eyebrow tm-pub-card__eyebrow--wide">
              Data handling
            </h2>
            <ul className="tm-pub-card__list">
              {trust.dataHandling.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          </section>

          <section className="tm-pub-card" aria-labelledby="tm-trust-compliance">
            <h2
              id="tm-trust-compliance"
              className="tm-pub-card__eyebrow tm-pub-card__eyebrow--wide"
            >
              Compliance posture
            </h2>
            <ul className="tm-pub-card__list">
              {trust.compliance.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          </section>
        </div>

        <section
          className="tm-pub-card tm-pub-card--night tm-pub-status-card"
          aria-labelledby="tm-trust-status"
        >
          <h2 id="tm-trust-status" className="tm-pub-card__eyebrow tm-pub-card__eyebrow--wide">
            System status
          </h2>
          {overall ? (
            <p className="tm-pub-status-card__state">
              <span
                className={`tm-pub-dot${overall.dot ? ` tm-pub-dot--${overall.dot}` : ''}`}
                aria-hidden="true"
              />
              {overall.label}
            </p>
          ) : null}
          <p className="tm-pub-card__body">
            {lastIncident
              ? `Last incident: ${lastIncident.title} (${lastIncident.component}).`
              : 'Live status and published incidents are on the status page.'}
          </p>
          <Link
            className="tm-pub-btn tm-pub-btn--sm tm-pub-btn--on-ink tm-pub-card__foot"
            href={trust.statusPath}
          >
            Open status page
          </Link>
        </section>
      </div>
    </>
  );
}

const OVERALL: Record<string, { label: string; dot?: 'warning' | 'danger' }> = {
  operational: { label: 'All systems operational' },
  investigating: { label: 'Investigating an incident', dot: 'danger' },
  identified: { label: 'Issue identified', dot: 'warning' },
  monitoring: { label: 'Monitoring a fix', dot: 'warning' },
};

/** PUB-06 — accessibility commitments, shown as the trust page's `#accessibility` section. */
function AccessibilitySection() {
  return (
    <section
      id="accessibility"
      className="tm-pub-section tm-pub-section--divided"
      aria-labelledby="tm-a11y-title"
    >
      <div className="tm-pub-head">
        <div className="tm-pub-intro">
          <p className="tm-pub-eyebrow">Accessibility</p>
          <h2 id="tm-a11y-title" className="tm-pub-display tm-pub-display--xs">
            Every workflow can be completed without a mouse.
          </h2>
        </div>
        <Link className="tm-pub-btn" href="/contact">
          Report a barrier
        </Link>
      </div>
      <div className="tm-pub-a11y">
        <div className="tm-pub-card tm-pub-card--roomy">
          <h3 className="tm-pub-card__eyebrow tm-pub-card__eyebrow--wide">Commitments</h3>
          <p className="tm-pub-card__body tm-pub-card__body--md">
            WCAG 2.2 AA is our floor, tested at 200% zoom, keyboard-only, with screen readers, in
            reduced motion, high contrast, coarse pointer, English and Arabic.
          </p>
          <hr className="tm-pub-card__rule" />
          <ul className="tm-pub-card__statements">
            <li>Drag is never the only way to move work.</li>
            <li>Colour is never the only carrier of state.</li>
            <li>Time tracks always have an ordered text equivalent.</li>
            <li>Focus is never hidden behind a sticky bar or sheet.</li>
          </ul>
        </div>
        <div className="tm-pub-card tm-pub-card--roomy">
          <h3 className="tm-pub-card__eyebrow tm-pub-card__eyebrow--wide">Supported modes</h3>
          <ul className="tm-pub-chips">
            {MODES.map((mode) => (
              <li key={mode}>{mode}</li>
            ))}
          </ul>
          <hr className="tm-pub-card__rule" />
          <p className="tm-pub-card__body tm-pub-card__body--md">
            Known gaps are published, not hidden. If something blocks you, tell us and we will treat
            it as a defect.
          </p>
        </div>
        <div className="tm-pub-card tm-pub-card--roomy tm-pub-card--ink">
          <h3 className="tm-pub-card__eyebrow tm-pub-card__eyebrow--wide">Conformance target</h3>
          <p className="tm-pub-big">AA</p>
          <p className="tm-pub-card__body">
            WCAG 2.2 level AA is the floor every screen is built and tested to.
          </p>
          <Link
            className="tm-pub-btn tm-pub-btn--sm tm-pub-btn--lime tm-pub-card__foot"
            href="/contact"
          >
            Ask about accessibility
          </Link>
        </div>
      </div>
    </section>
  );
}

const MODES = [
  'Keyboard only',
  'Screen reader',
  'Reduced motion',
  'High contrast',
  '200% zoom',
  'Touch / coarse pointer',
  'Arabic RTL',
  'Dark theme',
];
