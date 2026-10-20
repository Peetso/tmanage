'use client';

import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { InlineAlert, LoadingRegion, Skeleton } from '@tmanage/ui';
import { PublicIntro, PublicPage } from './public/PublicSite';
import { useT } from '../../lib/i18n/use-t';
import type { MessageKey } from '../../lib/i18n/t';
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
  const t = useT();
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
            eyebrow={t('TrustScreen.eyebrow')}
            titleId="tm-trust-title"
            size="sm"
            title={t('TrustScreen.title')}
          >
            <p className="tm-pub-lede tm-pub-lede--md">{t('TrustScreen.lede')}</p>
          </PublicIntro>
          <div className="tm-pub-btn-row">
            <a className="tm-pub-btn tm-pub-btn--sm tm-pub-btn--quiet" href="#tm-trust-controls">
              {t('TrustScreen.architectureOverview')}
            </a>
            <Link className="tm-pub-btn tm-pub-btn--sm tm-pub-btn--ink" href="/contact">
              {t('TrustScreen.requestSecurityPack')}
            </Link>
          </div>
        </div>

        <div className="tm-pub-stack">
          {trust.isPending ? (
            <LoadingRegion label={t('TrustScreen.loading')}>
              <Skeleton height="var(--row)" />
              <Skeleton height="var(--row)" />
              <Skeleton height="var(--row)" />
            </LoadingRegion>
          ) : trust.isError || !trust.data ? (
            <InlineAlert tone="danger" title={t('TrustScreen.loadError')} live>
              {trust.error instanceof NetworkError
                ? t('TrustScreen.networkError')
                : t('TrustScreen.genericError')}
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

const OVERALL_DOT: Record<string, 'warning' | 'danger' | undefined> = {
  operational: undefined,
  investigating: 'danger',
  identified: 'warning',
  monitoring: 'warning',
};

function Content({
  trust,
  status,
}: {
  trust: PublicTrustView;
  status: PublicStatusView | undefined;
}) {
  const t = useT();
  const overallLabels: Record<string, string> = {
    operational: t('TrustScreen.overallOperational'),
    investigating: t('TrustScreen.overallInvestigating'),
    identified: t('TrustScreen.overallIdentified'),
    monitoring: t('TrustScreen.overallMonitoring'),
  };
  const overallLabel = status ? overallLabels[status.overall] : undefined;
  const overallDot = status ? OVERALL_DOT[status.overall] : undefined;
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
              {t('TrustScreen.subprocessorsHeading')}
            </h2>
            <table className="tm-pub-table" aria-label={t('TrustScreen.subprocessorsAria')}>
              <thead>
                <tr>
                  <th scope="col">{t('TrustScreen.nameCol')}</th>
                  <th scope="col">{t('TrustScreen.purposeCol')}</th>
                  <th scope="col">{t('TrustScreen.locationCol')}</th>
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
              {t('TrustScreen.dataHandlingHeading')}
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
              {t('TrustScreen.complianceHeading')}
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
            {t('TrustScreen.systemStatusHeading')}
          </h2>
          {overallLabel ? (
            <p className="tm-pub-status-card__state">
              <span
                className={`tm-pub-dot${overallDot ? ` tm-pub-dot--${overallDot}` : ''}`}
                aria-hidden="true"
              />
              {overallLabel}
            </p>
          ) : null}
          <p className="tm-pub-card__body">
            {lastIncident
              ? `${t('TrustScreen.lastIncidentPrefix')}${lastIncident.title} (${lastIncident.component}).`
              : t('TrustScreen.noIncidentInfo')}
          </p>
          <Link
            className="tm-pub-btn tm-pub-btn--sm tm-pub-btn--on-ink tm-pub-card__foot"
            href={trust.statusPath}
          >
            {t('TrustScreen.openStatusPage')}
          </Link>
        </section>
      </div>
    </>
  );
}

/** PUB-06 — accessibility commitments, shown as the trust page's `#accessibility` section. */
function AccessibilitySection() {
  const t = useT();
  const modeKeys: readonly MessageKey[] = [
    'TrustScreen.modeKeyboard',
    'TrustScreen.modeScreenReader',
    'TrustScreen.modeReducedMotion',
    'TrustScreen.modeHighContrast',
    'TrustScreen.modeZoom',
    'TrustScreen.modeTouch',
    'TrustScreen.modeArabicRtl',
    'TrustScreen.modeDarkTheme',
  ];
  return (
    <section
      id="accessibility"
      className="tm-pub-section tm-pub-section--divided"
      aria-labelledby="tm-a11y-title"
    >
      <div className="tm-pub-head">
        <div className="tm-pub-intro">
          <p className="tm-pub-eyebrow">{t('TrustScreen.a11yEyebrow')}</p>
          <h2 id="tm-a11y-title" className="tm-pub-display tm-pub-display--xs">
            {t('TrustScreen.a11yTitle')}
          </h2>
        </div>
        <Link className="tm-pub-btn" href="/contact">
          {t('TrustScreen.reportBarrier')}
        </Link>
      </div>
      <div className="tm-pub-a11y">
        <div className="tm-pub-card tm-pub-card--roomy">
          <h3 className="tm-pub-card__eyebrow tm-pub-card__eyebrow--wide">
            {t('TrustScreen.commitmentsHeading')}
          </h3>
          <p className="tm-pub-card__body tm-pub-card__body--md">
            {t('TrustScreen.commitmentsBody')}
          </p>
          <hr className="tm-pub-card__rule" />
          <ul className="tm-pub-card__statements">
            <li>{t('TrustScreen.statement1')}</li>
            <li>{t('TrustScreen.statement2')}</li>
            <li>{t('TrustScreen.statement3')}</li>
            <li>{t('TrustScreen.statement4')}</li>
          </ul>
        </div>
        <div className="tm-pub-card tm-pub-card--roomy">
          <h3 className="tm-pub-card__eyebrow tm-pub-card__eyebrow--wide">
            {t('TrustScreen.supportedModesHeading')}
          </h3>
          <ul className="tm-pub-chips">
            {modeKeys.map((modeKey) => (
              <li key={modeKey}>{t(modeKey)}</li>
            ))}
          </ul>
          <hr className="tm-pub-card__rule" />
          <p className="tm-pub-card__body tm-pub-card__body--md">
            {t('TrustScreen.knownGapsBody')}
          </p>
        </div>
        <div className="tm-pub-card tm-pub-card--roomy tm-pub-card--ink">
          <h3 className="tm-pub-card__eyebrow tm-pub-card__eyebrow--wide">
            {t('TrustScreen.conformanceHeading')}
          </h3>
          <p className="tm-pub-big">AA</p>
          <p className="tm-pub-card__body">{t('TrustScreen.conformanceBody')}</p>
          <Link
            className="tm-pub-btn tm-pub-btn--sm tm-pub-btn--lime tm-pub-card__foot"
            href="/contact"
          >
            {t('TrustScreen.askAccessibility')}
          </Link>
        </div>
      </div>
    </section>
  );
}
