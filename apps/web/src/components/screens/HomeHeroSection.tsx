'use client';

import { useQuery } from '@tanstack/react-query';
import { InlineAlert, LoadingRegion, Skeleton } from '@tmanage/ui';
import { browserApiClient } from '../../lib/api/browser-client';
import { getHomePulse } from '../../lib/api/home';
import { ApiRequestError, NetworkError } from '../../lib/api/errors';
import type { ApiClient } from '../../lib/api/client';

export interface HomeHeroSectionProps {
  organizationSlug: string;
  client?: ApiClient;
}

/**
 * **HOME-01 Focus hero** — the top-of-Home Focus capsule (`41-WHOLE-APP-SCREEN` §1 HOME-01). It
 * reads the API's Pulse summary (`/home/pulse`) and states the acting user's day in four headline
 * numbers: open work, of it due today, what is waiting on them, and their meetings today.
 *
 * An additive region mounted above the existing My Day sections — it owns its own query and error
 * state and rewrites none of them, so it is disjoint from the rest of the screen. Every number is
 * the API's, derived from the same reads the sections render, so the capsule can show nothing the
 * lists below it do not. Read-only; no write, no new capability.
 */
export function HomeHeroSection({ organizationSlug, client }: HomeHeroSectionProps) {
  const api = client ?? browserApiClient();

  const pulse = useQuery({
    queryKey: ['home', 'pulse', organizationSlug],
    queryFn: () => getHomePulse(api, organizationSlug),
  });

  return (
    <section className="tm-panel tm-stack" aria-labelledby="tm-home-focus">
      <h2 id="tm-home-focus" className="tm-eyebrow">
        Your focus today
      </h2>

      {pulse.isError ? (
        <InlineAlert tone="danger" title="Could not load your focus" live>
          {describePulseError(pulse.error)}
        </InlineAlert>
      ) : null}

      {pulse.isPending ? (
        <LoadingRegion label="Loading your focus.">
          <Skeleton height="var(--row)" />
        </LoadingRegion>
      ) : null}

      {!pulse.isPending && !pulse.isError && pulse.data ? (
        <dl className="tm-detail-list" aria-label="Your focus today, in numbers">
          <div className="tm-detail-list__pair">
            <dt>Open work</dt>
            <dd>
              {pulse.data.openWork} open
              {pulse.data.dueToday > 0 ? `, ${pulse.data.dueToday} due today` : ''}
            </dd>
          </div>
          <div className="tm-detail-list__pair">
            <dt>Waiting on you</dt>
            <dd>{pulse.data.waitingOnYou} waiting</dd>
          </div>
          <div className="tm-detail-list__pair">
            <dt>Meetings today</dt>
            <dd>{pulse.data.meetingsToday} scheduled</dd>
          </div>
        </dl>
      ) : null}
    </section>
  );
}

function describePulseError(error: unknown): string {
  if (error instanceof ApiRequestError) return error.message;
  if (error instanceof NetworkError) return 'The network dropped before your focus loaded.';
  return 'Something went wrong loading your focus.';
}
