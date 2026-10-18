'use client';

import { useQuery } from '@tanstack/react-query';
import { Skeleton } from '@tmanage/ui';
import { browserApiClient } from '../../lib/api/browser-client';
import { getHomePulse } from '../../lib/api/home';
import { ApiRequestError, NetworkError } from '../../lib/api/errors';
import type { ApiClient } from '../../lib/api/client';
import '../../styles/screens/home.css';

export interface HomeHeroSectionProps {
  organizationSlug: string;
  client?: ApiClient | undefined;
}

/**
 * **HOME-01 header metrics** — the three big numbers at the end of the My Day header
 * (`display.metric`: a tabular number, a tone pill, what it means and where it comes from).
 *
 * It reads the API's Pulse summary (`/home/pulse`) and states the acting user's day: open work
 * (with how much of it is due today), what is waiting on them, and their meetings today. Every
 * number is the API's, derived from the same reads the sections below render, so the header can
 * show nothing the lists do not. Read-only; it owns its own query and error state.
 */
export function HomeHeroSection({ organizationSlug, client }: HomeHeroSectionProps) {
  const api = client ?? browserApiClient();

  const pulse = useQuery({
    queryKey: ['home', 'pulse', organizationSlug],
    queryFn: () => getHomePulse(api, organizationSlug),
  });

  return (
    <section className="tm-home-metrics" aria-labelledby="tm-home-focus">
      <h2 id="tm-home-focus" className="tm-home-metrics__heading">
        Your focus today
      </h2>

      {pulse.isError ? (
        <p className="tm-metric__source" role="alert">
          {describePulseError(pulse.error)}
        </p>
      ) : null}

      {pulse.isPending ? (
        <div className="tm-metric" role="status" aria-busy="true" aria-label="Loading your focus.">
          <Skeleton width="160px" height="56px" />
        </div>
      ) : null}

      {!pulse.isPending && !pulse.isError && pulse.data ? (
        <>
          <Metric
            value={pad(pulse.data.openWork)}
            pill={pulse.data.dueToday > 0 ? `${pulse.data.dueToday} due today` : 'on track'}
            tone={pulse.data.dueToday > 0 ? 'warning' : 'current'}
            label="open work items"
            source="assigned to you, every project"
          />
          <Metric
            value={String(pulse.data.waitingOnYou)}
            pill={pulse.data.waitingOnYou > 0 ? 'waiting' : 'clear'}
            tone={pulse.data.waitingOnYou > 0 ? 'warning' : 'neutral'}
            label="waiting on you"
            source="reviews and client requests"
          />
          <Metric
            value={String(pulse.data.meetingsToday)}
            pill="today"
            tone="neutral"
            label={pulse.data.meetingsToday === 1 ? 'meeting today' : 'meetings today'}
            source="on your calendar"
          />
        </>
      ) : null}
    </section>
  );
}

function Metric({
  value,
  pill,
  tone,
  label,
  source,
}: {
  value: string;
  pill: string;
  tone: 'current' | 'warning' | 'neutral';
  label: string;
  source: string;
}) {
  const pillClass = tone === 'neutral' ? 'tm-pill' : `tm-pill tm-pill--${tone}`;
  return (
    <div className="tm-metric">
      <div className="tm-metric__value-row">
        <span className="tm-metric__value">{value}</span>
        <span className={pillClass}>{pill}</span>
      </div>
      <span className="tm-metric__label">{label}</span>
      <span className="tm-metric__source">{source}</span>
    </div>
  );
}

/** HOME-01 draws single-digit day counts with a leading zero ("04"). */
function pad(value: number): string {
  return value < 10 ? `0${value}` : String(value);
}

function describePulseError(error: unknown): string {
  if (error instanceof ApiRequestError) return error.message;
  if (error instanceof NetworkError) return 'The network dropped before your focus loaded.';
  return 'Something went wrong loading your focus.';
}
