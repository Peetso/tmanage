'use client';

import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { InlineAlert, LiveAnnouncer, LoadingRegion, Skeleton, SkipLink } from '@tmanage/ui';
import { Wordmark } from '../brand/Wordmark';
import { browserApiClient } from '../../lib/api/browser-client';
import { getPublicHome } from '../../lib/api/public-site';
import { ApiRequestError, NetworkError } from '../../lib/api/errors';
import type { ApiClient } from '../../lib/api/client';

export interface MarketingHomeScreenProps {
  /** Injected in tests. Defaults to the browser client. */
  client?: ApiClient;
}

/**
 * **Marketing home** — the public & trust site's landing page (module 1, x156).
 *
 * `22-SCREEN-BY-SCREEN` §Public site / audit rank #1 (Public site Missing): the first page an
 * unauthenticated visitor sees. It reads `GET /v1/public/site/home`, a `@Public()` endpoint that
 * needs no session, no organization and no capability, and renders the deterministic content it
 * returns — a hero, a features grid, and two calls to action into sign-in.
 *
 * Two decisions worth stating:
 *
 * 1. **No tenant, no auth.** Like the sign-in door, this screen has no organization and reads a
 *    public endpoint. It uses neither `AppShell` (which needs a tenant) nor `IdentityShell` (a
 *    centred identity card); the landmarks — skip link, `<main>`, one `<h1>` — are built here so
 *    `A11Y-01` in `27-TEST-CATALOG` is satisfied structurally rather than borrowed from a shell
 *    that would render the wrong frame.
 * 2. **Content from the API, not baked in.** The copy lives in the API's `public-content` service
 *    so a later slice can reuse it (an OG card, the footer) without duplicating strings, and so the
 *    API↔web contract covers it. The screen degrades honestly: a skeleton while it loads, an
 *    `InlineAlert` if the read fails, never a blank page.
 */
export function MarketingHomeScreen({ client }: MarketingHomeScreenProps) {
  const api = client ?? browserApiClient();

  const home = useQuery({
    queryKey: ['public-home'],
    queryFn: () => getPublicHome(api),
  });

  return (
    <LiveAnnouncer>
      <div className="tm-marketing">
        <SkipLink targetId="tm-main" />

        <header className="tm-marketing__bar tm-row tm-row--between">
          <Wordmark />
          <nav aria-label="Primary">
            <Link className="tm-button tm-button--text tm-button--compact" href="/sign-in">
              Sign in
            </Link>
          </nav>
        </header>

        <main id="tm-main" className="tm-marketing__body" tabIndex={-1}>
          {home.isPending ? (
            <LoadingRegion label="Loading the page">
              <div className="tm-stack">
                <Skeleton />
                <Skeleton />
                <Skeleton />
              </div>
            </LoadingRegion>
          ) : home.isError ? (
            <InlineAlert tone="danger" title="This page could not load">
              {describeError(home.error)}
            </InlineAlert>
          ) : (
            <>
              <section className="tm-marketing__hero tm-stack" aria-labelledby="tm-hero-title">
                <h1 id="tm-hero-title">{home.data.hero.title}</h1>
                <p className="tm-marketing__lede">{home.data.hero.subtitle}</p>
                <div className="tm-row tm-row--wrap">
                  <Link className="tm-button tm-button--lime" href={home.data.hero.primaryCta.href}>
                    {home.data.hero.primaryCta.label}
                  </Link>
                  <Link
                    className="tm-button tm-button--outline"
                    href={home.data.hero.secondaryCta.href}
                  >
                    {home.data.hero.secondaryCta.label}
                  </Link>
                </div>
              </section>

              <section aria-labelledby="tm-features-title" className="tm-stack">
                <h2 id="tm-features-title">Why TManage</h2>
                <ul
                  className="tm-marketing__features"
                  style={{
                    display: 'grid',
                    gap: '1rem',
                    gridTemplateColumns: 'repeat(auto-fit, minmax(16rem, 1fr))',
                    listStyle: 'none',
                    margin: 0,
                    padding: 0,
                  }}
                >
                  {home.data.features.map((feature) => (
                    <li key={feature.title} className="tm-card tm-stack tm-stack--tight">
                      <h3>{feature.title}</h3>
                      <p>{feature.body}</p>
                    </li>
                  ))}
                </ul>
              </section>
            </>
          )}
        </main>

        <footer className="tm-marketing__footer">
          <p>TManage — client work, without the status meeting.</p>
        </footer>
      </div>
    </LiveAnnouncer>
  );
}

/** The same honest error copy the authed screens use: a refusal reads differently from an outage. */
function describeError(error: unknown): string {
  if (error instanceof ApiRequestError) return error.message;
  if (error instanceof NetworkError)
    return 'We could not reach TManage. Check your connection and try again.';
  return 'Something went wrong loading this page. Please try again.';
}
