'use client';

import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { InlineAlert, LoadingRegion, Skeleton } from '@tmanage/ui';
import { OrbLink, PublicPage } from './public/PublicSite';
import { browserApiClient } from '../../lib/api/browser-client';
import { getPublicHome } from '../../lib/api/public-site';
import { ApiRequestError, NetworkError } from '../../lib/api/errors';
import type { ApiClient } from '../../lib/api/client';

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

  const home = useQuery({
    queryKey: ['public-home'],
    queryFn: () => getPublicHome(api),
  });

  return (
    <PublicPage>
      {home.isPending ? (
        <LoadingRegion label="Loading the page">
          <div className="tm-stack">
            <Skeleton height="var(--t-display-xl-line)" />
            <Skeleton height="var(--t-display-xl-line)" />
            <Skeleton />
          </div>
        </LoadingRegion>
      ) : home.isError ? (
        <InlineAlert tone="danger" title="This page could not load">
          {describeError(home.error)}
        </InlineAlert>
      ) : (
        <>
          <section className="tm-pub-hero" aria-labelledby="tm-hero-title">
            <div className="tm-pub-hero__copy">
              <p className="tm-pub-eyebrow">
                Work operating system for service teams and their clients
              </p>
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
              One story, ten objects
            </h2>
            <ol className="tm-pub-track">
              {STORY.map((step) => (
                <li
                  key={step.label}
                  className={`tm-pub-step tm-pub-step--${step.state}`}
                  aria-current={step.state === 'now' ? 'step' : undefined}
                >
                  {step.state === 'done' ? (
                    <span className="tm-pub-step__check" aria-hidden="true">
                      ✓
                    </span>
                  ) : null}
                  {step.state === 'now' ? <span className="tm-pub-step__tag">Now</span> : null}
                  <span>{step.label}</span>
                  {step.note ? <span className="tm-pub-step__note">{step.note}</span> : null}
                </li>
              ))}
            </ol>
          </section>

          <section aria-labelledby="tm-features-title">
            <h2 id="tm-features-title" className="tm-visually-hidden">
              Why TManage
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
                    {SPLIT_EYEBROWS[index] ?? 'Across the work'}
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
const STORY: readonly { label: string; state: StepState; note?: string }[] = [
  { label: 'Request', state: 'done' },
  { label: 'Clarify', state: 'done' },
  { label: 'Commit', state: 'done' },
  { label: 'Plan into a milestone', state: 'now', note: 'committed date is set here' },
  { label: 'Execute', state: 'next' },
  { label: 'Review', state: 'next' },
  { label: 'Publish', state: 'next' },
  { label: 'Approve', state: 'later' },
  { label: 'Deliver', state: 'later' },
  { label: 'Evidence', state: 'later' },
];

const SPLIT_EYEBROWS = ['Inside the team', 'Outside, with the client'];

/** PUB-02's eight linked objects. */
const CHAIN: readonly { step: string; title: string; body: string; tone?: 'ink' | 'lime' }[] = [
  {
    step: '1 · Request',
    title: 'The client asks in their portal',
    body: 'Desired date recorded as a wish, never as a promise.',
  },
  {
    step: '2 · Discussion',
    title: 'The team clarifies in a thread',
    body: 'The thread stays attached to the request forever.',
  },
  {
    step: '3 · Commitment',
    title: 'Someone commits a date',
    body: 'Committed, forecast and desired are three separate fields.',
    tone: 'ink',
  },
  {
    step: '4 · Plan',
    title: 'It joins a milestone',
    body: 'Milestones move on evidence, not on task percentages.',
  },
  {
    step: '5 · Review',
    title: 'Internal review with criteria',
    body: 'The author cannot approve their own work.',
  },
  {
    step: '6 · Publication',
    title: 'Published as a governed version',
    body: 'You see the client’s exact view before you send it.',
    tone: 'lime',
  },
  {
    step: '7 · Decision',
    title: 'Approval binds to one version',
    body: 'Change the file and the approval is invalidated, not overwritten.',
  },
  {
    step: '8 · Evidence',
    title: 'Searchable, permission-safe',
    body: 'Answers cite the objects you are allowed to see.',
  },
];

function ProductSection() {
  return (
    <section
      id="product"
      className="tm-pub-section tm-pub-section--divided"
      aria-labelledby="tm-product-title"
    >
      <div className="tm-pub-columns tm-pub-columns--product">
        <div className="tm-pub-aside">
          <h2 id="tm-product-title" className="tm-pub-display tm-pub-display--lg">
            Nothing gets re-typed.
          </h2>
          <p className="tm-pub-lede">
            Most tools lose the thread between the ask and the delivery. TManage keeps one chain of
            custody: every object below is the same record, seen from a different angle.
          </p>
          <div className="tm-pub-card tm-pub-card--roomy">
            <p className="tm-pub-card__eyebrow tm-pub-card__eyebrow--wide">What that removes</p>
            <p className="tm-pub-card__body tm-pub-card__body--md">
              Status meetings to find out where things are. Screenshots pasted into email.
              &ldquo;Which version did you approve?&rdquo; Spreadsheets that track other
              spreadsheets.
            </p>
          </div>
        </div>
        <ol className="tm-pub-chain">
          {CHAIN.map((link) => (
            <li
              key={link.step}
              className={`tm-pub-card${link.tone ? ` tm-pub-card--${link.tone}` : ''}`}
            >
              <p className="tm-pub-card__eyebrow">{link.step}</p>
              <h3 className="tm-pub-card__title">{link.title}</h3>
              <p className="tm-pub-card__body">{link.body}</p>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}

/** PUB-03's portal story. The right side is an illustration of a client's view, not data. */
function PortalSection() {
  return (
    <section
      id="portal"
      className="tm-pub-section tm-pub-section--divided"
      aria-labelledby="tm-portal-title"
    >
      <div className="tm-pub-columns tm-pub-columns--portal">
        <div className="tm-pub-aside">
          <p className="tm-pub-eyebrow">The client portal</p>
          <h2 id="tm-portal-title" className="tm-pub-display tm-pub-display--md">
            Your client logs in and knows where things stand in thirty seconds.
          </h2>
          <p className="tm-pub-lede">
            One stage track, one number that matters, and the actions that belong to them. No module
            names, no empty tabs, no controls they cannot use.
          </p>
          <ul className="tm-pub-checks">
            {PORTAL_POINTS.map((point) => (
              <li key={point}>
                <span className="tm-pub-checks__mark" aria-hidden="true">
                  ✓
                </span>
                {point}
              </li>
            ))}
          </ul>
        </div>

        <figure className="tm-pub-preview" aria-label="Illustration of what a client sees">
          <div className="tm-pub-preview__head">
            <p className="tm-pub-eyebrow">What they see</p>
            <span className="tm-pub-preview__tag">client view</span>
          </div>
          <div className="tm-pub-preview__title-row">
            <p className="tm-pub-preview__title">Website relaunch</p>
            <p className="tm-pub-preview__metric">
              <strong>47</strong>
              days to launch
            </p>
          </div>
          <ol className="tm-pub-track">
            <li className="tm-pub-step tm-pub-step--done">Discovery</li>
            <li className="tm-pub-step tm-pub-step--now" aria-current="step">
              <span className="tm-pub-step__tag">Now</span>
              <span>Homepage direction</span>
              <span className="tm-pub-step__note">needs you</span>
            </li>
            <li className="tm-pub-step tm-pub-step--next">Migration</li>
            <li className="tm-pub-step tm-pub-step--later">Launch</li>
          </ol>
          <div className="tm-pub-action">
            <p className="tm-pub-card__eyebrow">Approval · about 10 minutes</p>
            <p className="tm-pub-action__title">Approve the homepage direction</p>
            <p className="tm-pub-action__row">
              <span className="tm-pub-action__button">Open the review</span>
              <span>Due 18 Aug</span>
            </p>
          </div>
        </figure>
      </div>
    </section>
  );
}

const PORTAL_POINTS = [
  'Progress from milestone evidence, not task counts',
  'Approvals bound to the exact version they reviewed',
  'Generated from an allowlist — internal work is invisible, not hidden',
];

/** The same honest error copy the authed screens use: a refusal reads differently from an outage. */
function describeError(error: unknown): string {
  if (error instanceof ApiRequestError) return error.message;
  if (error instanceof NetworkError)
    return 'We could not reach TManage. Check your connection and try again.';
  return 'Something went wrong loading this page. Please try again.';
}
