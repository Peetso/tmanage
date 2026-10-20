'use client';

import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { InlineAlert, LoadingRegion, Skeleton } from '@tmanage/ui';
import { OrbLink, PublicPage } from './public/PublicSite';
import { browserApiClient } from '../../lib/api/browser-client';
import { getPublicHome } from '../../lib/api/public-site';
import { ApiRequestError, NetworkError } from '../../lib/api/errors';
import type { ApiClient } from '../../lib/api/client';
import type { MessageKey } from '../../lib/i18n/t';
import { useT } from '../../lib/i18n/use-t';

export interface MarketingHomeScreenProps {
  /** Injected in tests. Defaults to the browser client. */
  client?: ApiClient;
}

/**
 * **Marketing home** — the public & trust site's landing page (module 1, x156), drawn to PUB-01
 * (landing), with PUB-02 (product overview) and PUB-03 (client portal page) as its `#product` and
 * `#portal` sections, since those pages are not routed on their own.
 *
 * It reads `GET /v1/public/site/home`, a `@Public()` endpoint that needs no session, no
 * organization and no capability. The hero copy, the calls to action and the feature panels come
 * from that response — the API's `public-content` service is the single source of the copy — and
 * the screen degrades honestly: a skeleton while it loads, an `InlineAlert` if the read fails,
 * never a blank page. The story track, the chain of custody and the portal illustration are static
 * product narrative from the approved design, not data.
 *
 * No tenant, no auth: `PublicPage` owns the landmarks (skip link, banner, one `<main>`), this
 * screen owns the one `<h1>`.
 */
export function MarketingHomeScreen({ client }: MarketingHomeScreenProps) {
  const api = client ?? browserApiClient();
  const t = useT();

  const home = useQuery({
    queryKey: ['public-home'],
    queryFn: () => getPublicHome(api),
  });

  return (
    <PublicPage>
      {home.isPending ? (
        <LoadingRegion label={t('MarketingHomeScreen.loadingLabel')}>
          <div className="tm-stack">
            <Skeleton height="var(--t-display-xl-line)" />
            <Skeleton height="var(--t-display-xl-line)" />
            <Skeleton />
          </div>
        </LoadingRegion>
      ) : home.isError ? (
        <InlineAlert tone="danger" title={t('MarketingHomeScreen.errorTitle')}>
          {describeError(t, home.error)}
        </InlineAlert>
      ) : (
        <>
          <section className="tm-pub-hero" aria-labelledby="tm-hero-title">
            <div className="tm-pub-hero__copy">
              <p className="tm-pub-eyebrow">{t('MarketingHomeScreen.heroEyebrow')}</p>
              <h1 id="tm-hero-title" className="tm-pub-display tm-pub-display--xl">
                {home.data.hero.title}
              </h1>
              <p className="tm-pub-lede">{home.data.hero.subtitle}</p>
            </div>
            <div className="tm-pub-hero__ctas">
              <OrbLink href={home.data.hero.primaryCta.href} size="lg">
                {home.data.hero.primaryCta.label}
              </OrbLink>
              <Link className="tm-pub-btn" href={home.data.hero.secondaryCta.href}>
                {home.data.hero.secondaryCta.label}
              </Link>
            </div>
          </section>

          <section className="tm-pub-story" aria-labelledby="tm-story-title">
            <h2 id="tm-story-title" className="tm-pub-eyebrow">
              {t('MarketingHomeScreen.storyHeading')}
            </h2>
            <ol className="tm-pub-track">
              {STORY.map((step) => (
                <li
                  key={step.labelKey}
                  className={`tm-pub-step tm-pub-step--${step.state}`}
                  aria-current={step.state === 'now' ? 'step' : undefined}
                >
                  {step.state === 'done' ? (
                    <span className="tm-pub-step__check" aria-hidden="true">
                      ✓
                    </span>
                  ) : null}
                  {step.state === 'now' ? (
                    <span className="tm-pub-step__tag">{t('MarketingHomeScreen.nowTag')}</span>
                  ) : null}
                  <span>{t(step.labelKey)}</span>
                  {step.noteKey ? (
                    <span className="tm-pub-step__note">{t(step.noteKey)}</span>
                  ) : null}
                </li>
              ))}
            </ol>
          </section>

          <section aria-labelledby="tm-features-title">
            <h2 id="tm-features-title" className="tm-visually-hidden">
              {t('MarketingHomeScreen.featuresHeading')}
            </h2>
            <ul
              className={`tm-pub-split${home.data.features.length > 2 ? ' tm-pub-split--three' : ''}`}
            >
              {home.data.features.map((feature, index) => (
                <li
                  key={feature.title}
                  className={`tm-pub-panel${index === 1 ? ' tm-pub-panel--lime' : ''}`}
                >
                  <p className="tm-pub-panel__eyebrow">
                    <span className="tm-pub-panel__icon" aria-hidden="true">
                      {index === 1 ? '◎' : '■'}
                    </span>
                    {t(SPLIT_EYEBROW_KEYS[index] ?? 'MarketingHomeScreen.splitEyebrowFallback')}
                  </p>
                  <h3 className="tm-pub-panel__title">{feature.title}</h3>
                  <p className="tm-pub-panel__body">{feature.body}</p>
                  <div className="tm-pub-panel__visual" aria-hidden="true" />
                </li>
              ))}
            </ul>
          </section>

          <ProductSection />
          <PortalSection />
        </>
      )}
    </PublicPage>
  );
}

type StepState = 'done' | 'now' | 'next' | 'later';

/** PUB-01's story track: static product narrative; the fourth step is the one shown as current. */
const STORY: readonly { labelKey: MessageKey; state: StepState; noteKey?: MessageKey }[] = [
  { labelKey: 'MarketingHomeScreen.storyRequest', state: 'done' },
  { labelKey: 'MarketingHomeScreen.storyClarify', state: 'done' },
  { labelKey: 'MarketingHomeScreen.storyCommit', state: 'done' },
  {
    labelKey: 'MarketingHomeScreen.storyPlan',
    state: 'now',
    noteKey: 'MarketingHomeScreen.storyPlanNote',
  },
  { labelKey: 'MarketingHomeScreen.storyExecute', state: 'next' },
  { labelKey: 'MarketingHomeScreen.storyReview', state: 'next' },
  { labelKey: 'MarketingHomeScreen.storyPublish', state: 'next' },
  { labelKey: 'MarketingHomeScreen.storyApprove', state: 'later' },
  { labelKey: 'MarketingHomeScreen.storyDeliver', state: 'later' },
  { labelKey: 'MarketingHomeScreen.storyEvidence', state: 'later' },
];

const SPLIT_EYEBROW_KEYS: readonly MessageKey[] = [
  'MarketingHomeScreen.splitEyebrow0',
  'MarketingHomeScreen.splitEyebrow1',
];

/** PUB-02's eight linked objects. */
const CHAIN: readonly {
  stepKey: MessageKey;
  titleKey: MessageKey;
  bodyKey: MessageKey;
  tone?: 'ink' | 'lime';
}[] = [
  {
    stepKey: 'MarketingHomeScreen.chain1Step',
    titleKey: 'MarketingHomeScreen.chain1Title',
    bodyKey: 'MarketingHomeScreen.chain1Body',
  },
  {
    stepKey: 'MarketingHomeScreen.chain2Step',
    titleKey: 'MarketingHomeScreen.chain2Title',
    bodyKey: 'MarketingHomeScreen.chain2Body',
  },
  {
    stepKey: 'MarketingHomeScreen.chain3Step',
    titleKey: 'MarketingHomeScreen.chain3Title',
    bodyKey: 'MarketingHomeScreen.chain3Body',
    tone: 'ink',
  },
  {
    stepKey: 'MarketingHomeScreen.chain4Step',
    titleKey: 'MarketingHomeScreen.chain4Title',
    bodyKey: 'MarketingHomeScreen.chain4Body',
  },
  {
    stepKey: 'MarketingHomeScreen.chain5Step',
    titleKey: 'MarketingHomeScreen.chain5Title',
    bodyKey: 'MarketingHomeScreen.chain5Body',
  },
  {
    stepKey: 'MarketingHomeScreen.chain6Step',
    titleKey: 'MarketingHomeScreen.chain6Title',
    bodyKey: 'MarketingHomeScreen.chain6Body',
    tone: 'lime',
  },
  {
    stepKey: 'MarketingHomeScreen.chain7Step',
    titleKey: 'MarketingHomeScreen.chain7Title',
    bodyKey: 'MarketingHomeScreen.chain7Body',
  },
  {
    stepKey: 'MarketingHomeScreen.chain8Step',
    titleKey: 'MarketingHomeScreen.chain8Title',
    bodyKey: 'MarketingHomeScreen.chain8Body',
  },
];

function ProductSection() {
  const t = useT();
  return (
    <section
      id="product"
      className="tm-pub-section tm-pub-section--divided"
      aria-labelledby="tm-product-title"
    >
      <div className="tm-pub-columns tm-pub-columns--product">
        <div className="tm-pub-aside">
          <h2 id="tm-product-title" className="tm-pub-display tm-pub-display--lg">
            {t('MarketingHomeScreen.productHeading')}
          </h2>
          <p className="tm-pub-lede">{t('MarketingHomeScreen.productLede')}</p>
          <div className="tm-pub-card tm-pub-card--roomy">
            <p className="tm-pub-card__eyebrow tm-pub-card__eyebrow--wide">
              {t('MarketingHomeScreen.productRemovesEyebrow')}
            </p>
            <p className="tm-pub-card__body tm-pub-card__body--md">
              {t('MarketingHomeScreen.productRemovesBody')}
            </p>
          </div>
        </div>
        <ol className="tm-pub-chain">
          {CHAIN.map((link) => (
            <li
              key={link.stepKey}
              className={`tm-pub-card${link.tone ? ` tm-pub-card--${link.tone}` : ''}`}
            >
              <p className="tm-pub-card__eyebrow">{t(link.stepKey)}</p>
              <h3 className="tm-pub-card__title">{t(link.titleKey)}</h3>
              <p className="tm-pub-card__body">{t(link.bodyKey)}</p>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}

/** PUB-03's portal story. The right side is an illustration of a client's view, not data. */
function PortalSection() {
  const t = useT();
  return (
    <section
      id="portal"
      className="tm-pub-section tm-pub-section--divided"
      aria-labelledby="tm-portal-title"
    >
      <div className="tm-pub-columns tm-pub-columns--portal">
        <div className="tm-pub-aside">
          <p className="tm-pub-eyebrow">{t('MarketingHomeScreen.portalEyebrow')}</p>
          <h2 id="tm-portal-title" className="tm-pub-display tm-pub-display--md">
            {t('MarketingHomeScreen.portalHeading')}
          </h2>
          <p className="tm-pub-lede">{t('MarketingHomeScreen.portalLede')}</p>
          <ul className="tm-pub-checks">
            {PORTAL_POINT_KEYS.map((pointKey) => (
              <li key={pointKey}>
                <span className="tm-pub-checks__mark" aria-hidden="true">
                  ✓
                </span>
                {t(pointKey)}
              </li>
            ))}
          </ul>
        </div>

        <figure className="tm-pub-preview" aria-label={t('MarketingHomeScreen.previewAria')}>
          <div className="tm-pub-preview__head">
            <p className="tm-pub-eyebrow">{t('MarketingHomeScreen.previewEyebrow')}</p>
            <span className="tm-pub-preview__tag">{t('MarketingHomeScreen.previewTag')}</span>
          </div>
          <div className="tm-pub-preview__title-row">
            <p className="tm-pub-preview__title">{t('MarketingHomeScreen.previewTitle')}</p>
            <p className="tm-pub-preview__metric">
              <strong>47</strong> {t('MarketingHomeScreen.previewMetricSuffix')}
            </p>
          </div>
          <ol className="tm-pub-track">
            <li className="tm-pub-step tm-pub-step--done">
              {t('MarketingHomeScreen.previewStepDiscovery')}
            </li>
            <li className="tm-pub-step tm-pub-step--now" aria-current="step">
              <span className="tm-pub-step__tag">{t('MarketingHomeScreen.nowTag')}</span>
              <span>{t('MarketingHomeScreen.previewStepHomepage')}</span>
              <span className="tm-pub-step__note">
                {t('MarketingHomeScreen.previewStepHomepageNote')}
              </span>
            </li>
            <li className="tm-pub-step tm-pub-step--next">
              {t('MarketingHomeScreen.previewStepMigration')}
            </li>
            <li className="tm-pub-step tm-pub-step--later">
              {t('MarketingHomeScreen.previewStepLaunch')}
            </li>
          </ol>
          <div className="tm-pub-action">
            <p className="tm-pub-card__eyebrow">{t('MarketingHomeScreen.previewActionEyebrow')}</p>
            <p className="tm-pub-action__title">{t('MarketingHomeScreen.previewActionTitle')}</p>
            <p className="tm-pub-action__row">
              <span className="tm-pub-action__button">
                {t('MarketingHomeScreen.previewActionButton')}
              </span>
              <span>{t('MarketingHomeScreen.previewActionDue')}</span>
            </p>
          </div>
        </figure>
      </div>
    </section>
  );
}

const PORTAL_POINT_KEYS: readonly MessageKey[] = [
  'MarketingHomeScreen.portalPoint0',
  'MarketingHomeScreen.portalPoint1',
  'MarketingHomeScreen.portalPoint2',
];

/** The same honest error copy the authed screens use: a refusal reads differently from an outage. */
function describeError(t: (key: MessageKey) => string, error: unknown): string {
  if (error instanceof ApiRequestError) return error.message;
  if (error instanceof NetworkError) return t('MarketingHomeScreen.errorNetwork');
  return t('MarketingHomeScreen.errorGeneric');
}
