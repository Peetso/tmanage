'use client';

import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { Skeleton } from '@tmanage/ui';
import { useT } from '../../lib/i18n/use-t';
import { browserApiClient } from '../../lib/api/browser-client';
import { getHomePulse } from '../../lib/api/home';
import { OFFLINE_LINES, useDescribeApiError } from '../../lib/api/describe-error';
import type { ApiClient } from '../../lib/api/client';
import '../../styles/screens/home.css';

/** The three numbers, when the page already holds them (My Day v4: its one ranked read, C4). */
export interface HomeHeroCounts {
  readonly openWork: number;
  readonly dueToday: number;
  readonly waitingOnYou: number;
  readonly meetingsToday: number;
}

/** Where each number goes when pressed (spec MYDAY-V4 §5: a number opens its list). */
export interface HomeHeroLinks {
  readonly openWork: string;
  readonly waitingOnYou: string;
  readonly meetingsToday: string;
}

export interface HomeHeroSectionProps {
  organizationSlug: string;
  client?: ApiClient | undefined;
  /** Given, the numbers are the page's own and `/home/pulse` is not read. */
  counts?: HomeHeroCounts | undefined;
  links?: HomeHeroLinks | undefined;
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
export function HomeHeroSection({ organizationSlug, client, counts, links }: HomeHeroSectionProps) {
  const describePulseError = useDescribeApiError(OFFLINE_LINES);
  const t = useT();
  const api = client ?? browserApiClient();

  const read = useQuery({
    queryKey: ['home', 'pulse', organizationSlug],
    queryFn: () => getHomePulse(api, organizationSlug),
    enabled: counts === undefined,
  });
  const pulse =
    counts === undefined ? read : { isPending: false, isError: false, error: null, data: counts };

  return (
    <section className="tm-home-metrics" aria-labelledby="tm-home-focus">
      <h2 id="tm-home-focus" className="tm-home-metrics__heading">
        {t('HomeHeroSection.heading')}
      </h2>

      {pulse.isError ? (
        <p className="tm-metric__source" role="alert">
          {describePulseError(pulse.error)}
        </p>
      ) : null}

      {pulse.isPending ? (
        <div
          className="tm-metric"
          role="status"
          aria-busy="true"
          aria-label={t('HomeHeroSection.loading')}
        >
          <Skeleton width="160px" height="56px" />
        </div>
      ) : null}

      {!pulse.isPending && !pulse.isError && pulse.data ? (
        <>
          <Metric
            value={pad(pulse.data.openWork)}
            pill={
              pulse.data.dueToday > 0
                ? `${pulse.data.dueToday} ${t('HomeHeroSection.dueToday')}`
                : t('HomeHeroSection.onTrack')
            }
            tone={pulse.data.dueToday > 0 ? 'warning' : 'current'}
            label={t('HomeHeroSection.openWorkLabel')}
            source={t('HomeHeroSection.openWorkSource')}
            href={links?.openWork}
          />
          <Metric
            value={String(pulse.data.waitingOnYou)}
            pill={
              pulse.data.waitingOnYou > 0
                ? t('HomeHeroSection.waiting')
                : t('HomeHeroSection.clear')
            }
            tone={pulse.data.waitingOnYou > 0 ? 'warning' : 'neutral'}
            label={t('HomeHeroSection.waitingLabel')}
            source={t('HomeHeroSection.waitingSource')}
            href={links?.waitingOnYou}
          />
          <Metric
            value={String(pulse.data.meetingsToday)}
            pill={t('HomeHeroSection.today')}
            tone="neutral"
            label={
              pulse.data.meetingsToday === 1
                ? t('HomeHeroSection.meetingToday')
                : t('HomeHeroSection.meetingsToday')
            }
            source={t('HomeHeroSection.meetingsSource')}
            href={links?.meetingsToday}
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
  href,
}: {
  value: string;
  pill: string;
  tone: 'current' | 'warning' | 'neutral';
  label: string;
  source: string;
  /** Given, the whole number is a link to its list; the look does not change. */
  href?: string | undefined;
}) {
  const pillClass = tone === 'neutral' ? 'tm-pill' : `tm-pill tm-pill--${tone}`;
  const body = (
    <>
      <span className="tm-metric__value-row">
        <span className="tm-metric__value">{value}</span>
        <span className={pillClass}>{pill}</span>
      </span>
      <span className="tm-metric__label">{label}</span>
      <span className="tm-metric__source">{source}</span>
    </>
  );
  return href ? (
    <Link href={href} className="tm-metric tm-home-metrics__link">
      {body}
    </Link>
  ) : (
    <div className="tm-metric">{body}</div>
  );
}

/** HOME-01 draws single-digit day counts with a leading zero ("04"). */
function pad(value: number): string {
  return value < 10 ? `0${value}` : String(value);
}
