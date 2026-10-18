'use client';

import { useQuery } from '@tanstack/react-query';
import { InlineAlert, LoadingRegion, Skeleton } from '@tmanage/ui';
import { PublicPage } from './public/PublicSite';
import { browserApiClient } from '../../lib/api/browser-client';
import { fetchPublicStatus } from '../../lib/api/public-site';
import type {
  IncidentStatus,
  PublicIncidentView,
  PublicStatusView,
} from '../../lib/api/public-site';
import { ApiRequestError, NetworkError } from '../../lib/api/errors';
import type { ApiClient } from '../../lib/api/client';

export interface StatusScreenProps {
  /** Injected in tests. Defaults to the browser client. */
  client?: ApiClient;
}

/**
 * **Public status page** — Public & trust site, module 1 (x159). Reads the one genuinely public
 * endpoint, `GET /v1/public/site/status`, with no session and no organization.
 *
 * Two things it deliberately does not do: it never authenticates (the read is `@Public()` on the
 * API, and the client declares `authentication: 'none'`), and it never shows a draft — the API
 * returns published incidents only, so there is nothing here for this screen to filter. It renders
 * an overall banner and the recent incident timeline, newest first, exactly as the API orders them.
 *
 * Drawn to PUB-07: the overall banner, the components named in published incidents, the last
 * incident, and thirteen weekly bars for the last 90 days. Every number is derived from the
 * incidents the API returns; nothing (an uptime percentage, a component catalog) is invented.
 * `PublicPage` (status bar variant) owns the skip link, the `<main>` and the live region; this screen
 * owns the one `<h1>` and the content.
 */
export function StatusScreen({ client }: StatusScreenProps) {
  const api = client ?? browserApiClient();

  const status = useQuery({
    queryKey: ['public-status'],
    queryFn: () => fetchPublicStatus(api),
  });

  return (
    <PublicPage
      bar="status"
      width="narrow"
      statusMeta={
        status.isSuccess ? (
          <>
            Updated <time dateTime={status.data.asOf}>{formatMoment(status.data.asOf)}</time>
          </>
        ) : null
      }
    >
      {status.isPending ? (
        <>
          <h1 className="tm-visually-hidden">Service status</h1>
          <LoadingRegion label="Loading the service status." className="tm-stack tm-stack--tight">
            <Skeleton height="var(--row)" />
            <Skeleton height="var(--row)" />
          </LoadingRegion>
        </>
      ) : null}

      {status.isError ? (
        <>
          <h1 className="tm-pub-banner__title">Service status</h1>
          <InlineAlert tone="danger" title="Could not load the status page" live>
            {describe(status.error)}
          </InlineAlert>
        </>
      ) : null}

      {status.isSuccess ? <StatusBody status={status.data} /> : null}
    </PublicPage>
  );
}

const DAY = 24 * 60 * 60 * 1000;
const WINDOW_DAYS = 91;

function StatusBody({ status }: { status: PublicStatusView }) {
  const overall = OVERALL[status.overall];
  const asOf = parseTime(status.asOf) ?? Date.now();
  const recent = status.incidents.filter((incident) => {
    const at = parseTime(incident.startedAt);
    return at !== null && asOf - at <= WINDOW_DAYS * DAY;
  });
  const open = status.incidents.filter((incident) => incident.status !== 'resolved');
  const [latest, ...older] = status.incidents;
  const components = componentRows(status.incidents);
  const weeks = weekBars(status.incidents, asOf);

  return (
    <>
      <section className="tm-pub-banner" aria-labelledby="tm-status-title">
        <span
          className={`tm-pub-banner__dot${overall.dot ? ` tm-pub-banner__dot--${overall.dot}` : ''}`}
          aria-hidden="true"
        />
        <div className="tm-pub-banner__copy">
          <h1 id="tm-status-title" className="tm-pub-banner__title">
            {overall.label}
          </h1>
          <p className="tm-pub-banner__body">{summarise(recent.length, open.length)}</p>
        </div>
        <p className="tm-pub-banner__metric">
          <strong>{recent.length}</strong>
          <span>Incidents · 90 days</span>
        </p>
      </section>

      <div className="tm-pub-status-grid">
        <div className="tm-pub-status-col">
          <section className="tm-pub-status-col" aria-labelledby="tm-status-components">
            <h2 id="tm-status-components" className="tm-pub-eyebrow">
              Components
            </h2>
            {components.length === 0 ? (
              <p className="tm-pub-card tm-pub-card__body tm-pub-card--dashed">
                No component has reported a problem.
              </p>
            ) : (
              <ul className="tm-pub-components">
                {components.map((row) => (
                  <li key={row.component}>
                    <span
                      className={`tm-pub-components__mark${row.open ? ' tm-pub-components__mark--warning' : ''}`}
                      aria-hidden="true"
                    />
                    <div>
                      <p className="tm-pub-components__name">{row.component}</p>
                      <p className="tm-pub-components__meta">
                        {row.count === 1 ? '1 incident' : `${row.count} incidents`} · last{' '}
                        {formatDay(row.lastAt)}
                      </p>
                    </div>
                    <p className="tm-pub-components__state">
                      {row.open ? 'Affected' : 'Operational'}
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </section>

          {older.length > 0 ? (
            <section className="tm-pub-status-col" aria-labelledby="tm-status-history">
              <h2 id="tm-status-history" className="tm-pub-eyebrow">
                Earlier incidents
              </h2>
              <ol className="tm-pub-stack" aria-label="Earlier incidents, newest first">
                {older.map((incident) => (
                  <li key={incident.id}>
                    <IncidentCard incident={incident} level={3} />
                  </li>
                ))}
              </ol>
            </section>
          ) : null}
        </div>

        <div className="tm-pub-status-col">
          <section className="tm-pub-status-col" aria-labelledby="tm-status-incidents">
            <h2 id="tm-status-incidents" className="tm-pub-eyebrow">
              Last incident
            </h2>
            {latest ? (
              <IncidentCard incident={latest} level={3} />
            ) : (
              <p className="tm-pub-card tm-pub-card__body tm-pub-card--dashed">
                No incidents have been reported.
              </p>
            )}
          </section>

          <section className="tm-pub-card tm-pub-card--roomy" aria-labelledby="tm-status-weeks">
            <h2 id="tm-status-weeks" className="tm-pub-eyebrow">
              Last 90 days
            </h2>
            <ol className="tm-pub-bars" aria-label="Weeks in the last 90 days, oldest first">
              {weeks.map((week) => (
                <li
                  key={week.start}
                  className={week.incidents > 0 ? 'tm-pub-bars__bad' : undefined}
                  aria-label={`Week of ${formatDay(week.start)}: ${
                    week.incidents === 0
                      ? 'no incidents'
                      : week.incidents === 1
                        ? '1 incident'
                        : `${week.incidents} incidents`
                  }`}
                />
              ))}
            </ol>
            <p className="tm-pub-card__body">
              {weeks.some((week) => week.incidents > 0)
                ? 'Each bar is one week. Shorter amber bars are weeks with a published incident.'
                : 'Each bar is one week. No incident was published in this window.'}
            </p>
          </section>
        </div>
      </div>
    </>
  );
}

function IncidentCard({ incident, level }: { incident: PublicIncidentView; level: 2 | 3 }) {
  const state = INCIDENT[incident.status];
  const Heading = level === 2 ? 'h2' : 'h3';
  return (
    <article
      className={`tm-pub-card tm-pub-card--roomy tm-pub-incident tm-pub-incident--${
        incident.status === 'resolved' ? 'resolved' : 'open'
      }`}
    >
      <p className="tm-pub-card__eyebrow">
        {formatDay(parseTime(incident.startedAt) ?? 0)}
        {duration(incident)} · {state.label} · {incident.component}
      </p>
      <Heading className="tm-pub-card__title">{incident.title}</Heading>
      <p className="tm-pub-card__body">{incident.body}</p>
    </article>
  );
}

/** The overall banner's word and dot for each state. `operational` is the only green one. */
const OVERALL: Record<
  PublicStatusView['overall'],
  { label: string; dot?: 'warning' | 'danger' | 'live' }
> = {
  operational: { label: 'All systems operational' },
  investigating: { label: 'Investigating an incident', dot: 'danger' },
  identified: { label: 'Issue identified', dot: 'warning' },
  monitoring: { label: 'Monitoring a fix', dot: 'live' },
};

/** Per-incident state word. */
const INCIDENT: Record<IncidentStatus, { label: string }> = {
  investigating: { label: 'Investigating' },
  identified: { label: 'Identified' },
  monitoring: { label: 'Monitoring' },
  resolved: { label: 'Resolved' },
};

function summarise(recent: number, open: number): string {
  const opening =
    open === 0 ? '' : open === 1 ? 'One incident is open. ' : `${open} incidents are open. `;
  if (recent === 0) return `${opening}No incidents in the last 90 days.`;
  if (recent === 1) return `${opening}One incident in the last 90 days.`;
  return `${opening}${recent} incidents in the last 90 days.`;
}

/** One row per component named in a published incident, newest first. */
function componentRows(incidents: readonly PublicIncidentView[]) {
  const rows = new Map<
    string,
    { component: string; count: number; lastAt: number; open: boolean }
  >();
  for (const incident of incidents) {
    const at = parseTime(incident.startedAt) ?? 0;
    const row = rows.get(incident.component) ?? {
      component: incident.component,
      count: 0,
      lastAt: 0,
      open: false,
    };
    row.count += 1;
    row.lastAt = Math.max(row.lastAt, at);
    row.open = row.open || incident.status !== 'resolved';
    rows.set(incident.component, row);
  }
  return [...rows.values()].sort((a, b) => b.lastAt - a.lastAt);
}

/** Thirteen weekly buckets ending at `asOf`, each counting the incidents that started in it. */
function weekBars(incidents: readonly PublicIncidentView[], asOf: number) {
  const weeks = Array.from({ length: 13 }, (_, index) => ({
    start: asOf - (13 - index) * 7 * DAY,
    incidents: 0,
  }));
  for (const incident of incidents) {
    const at = parseTime(incident.startedAt);
    if (at === null) continue;
    const index = Math.floor((at - (asOf - 13 * 7 * DAY)) / (7 * DAY));
    const week = weeks[index];
    if (week) week.incidents += 1;
  }
  return weeks;
}

function duration(incident: PublicIncidentView): string {
  const start = parseTime(incident.startedAt);
  const end = incident.resolvedAt === null ? null : parseTime(incident.resolvedAt);
  if (start === null || end === null || end < start) return '';
  const minutes = Math.round((end - start) / 60000);
  if (minutes < 60) return ` · ${minutes} min`;
  const hours = Math.round(minutes / 6) / 10;
  return ` · ${hours} h`;
}

function parseTime(iso: string): number | null {
  const at = new Date(iso).getTime();
  return Number.isNaN(at) ? null : at;
}

/** Turn a thrown value into a sentence a person can act on. Never leaks a stack or a cause. */
function describe(error: unknown): string {
  if (error instanceof ApiRequestError) return error.message;
  if (error instanceof NetworkError) return 'The status service did not answer. Try again shortly.';
  return 'Something went wrong. Try again.';
}

function formatDay(at: number): string {
  return new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short' }).format(at);
}

/** Format an ISO timestamp for display, following the browser's locale. */
function formatMoment(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso;
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(at);
}
