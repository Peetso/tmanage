'use client';

import { useQuery } from '@tanstack/react-query';
import { InlineAlert, LoadingRegion, Skeleton } from '@tmanage/ui';
import { PublicPage } from './public/PublicSite';
import { useT } from '../../lib/i18n/use-t';
import type { MessageKey } from '../../lib/i18n/t';
import { browserApiClient } from '../../lib/api/browser-client';
import { fetchPublicStatus } from '../../lib/api/public-site';
import type {
  IncidentStatus,
  PublicIncidentView,
  PublicStatusView,
} from '../../lib/api/public-site';
import { STATUS_LINES, useDescribeApiError } from '../../lib/api/describe-error';
import type { ApiClient } from '../../lib/api/client';
import { appLocale } from '../../lib/i18n/app-locale';

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
  const describe = useDescribeApiError(STATUS_LINES);
  const t = useT();
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
            {t('StatusScreen.updatedPrefix')}
            <time dateTime={status.data.asOf}>{formatMoment(status.data.asOf)}</time>
          </>
        ) : null
      }
    >
      {status.isPending ? (
        <>
          <h1 className="tm-visually-hidden">{t('StatusScreen.serviceStatus')}</h1>
          <LoadingRegion label={t('StatusScreen.loading')} className="tm-stack tm-stack--tight">
            <Skeleton height="var(--row)" />
            <Skeleton height="var(--row)" />
          </LoadingRegion>
        </>
      ) : null}

      {status.isError ? (
        <>
          <h1 className="tm-pub-banner__title">{t('StatusScreen.serviceStatus')}</h1>
          <InlineAlert tone="danger" title={t('StatusScreen.loadError')} live>
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

/** The overall banner's dot for each state. `operational` is the only one with no dot (green). */
const OVERALL_DOT: Record<PublicStatusView['overall'], 'warning' | 'danger' | 'live' | undefined> =
  {
    operational: undefined,
    investigating: 'danger',
    identified: 'warning',
    monitoring: 'live',
  };

function StatusBody({ status }: { status: PublicStatusView }) {
  const t = useT();
  const overallLabels: Record<PublicStatusView['overall'], string> = {
    operational: t('StatusScreen.overallOperational'),
    investigating: t('StatusScreen.overallInvestigating'),
    identified: t('StatusScreen.overallIdentified'),
    monitoring: t('StatusScreen.overallMonitoring'),
  };
  const overallLabel = overallLabels[status.overall];
  const overallDot = OVERALL_DOT[status.overall];
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
          className={`tm-pub-banner__dot${overallDot ? ` tm-pub-banner__dot--${overallDot}` : ''}`}
          aria-hidden="true"
        />
        <div className="tm-pub-banner__copy">
          <h1 id="tm-status-title" className="tm-pub-banner__title">
            {overallLabel}
          </h1>
          <p className="tm-pub-banner__body">{summarise(recent.length, open.length, t)}</p>
        </div>
        <p className="tm-pub-banner__metric">
          <strong>{recent.length}</strong>
          <span>{t('StatusScreen.incidents90Days')}</span>
        </p>
      </section>

      <div className="tm-pub-status-grid">
        <div className="tm-pub-status-col">
          <section className="tm-pub-status-col" aria-labelledby="tm-status-components">
            <h2 id="tm-status-components" className="tm-pub-eyebrow">
              {t('StatusScreen.componentsHeading')}
            </h2>
            {components.length === 0 ? (
              <p className="tm-pub-card tm-pub-card__body tm-pub-card--dashed">
                {t('StatusScreen.noComponentProblem')}
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
                        {row.count === 1
                          ? t('StatusScreen.oneIncident')
                          : `${row.count} ${t('StatusScreen.incidentsCount')}`}{' '}
                        {t('StatusScreen.lastLabel')} {formatDay(row.lastAt)}
                      </p>
                    </div>
                    <p className="tm-pub-components__state">
                      {row.open ? t('StatusScreen.affected') : t('StatusScreen.operational')}
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </section>

          {older.length > 0 ? (
            <section className="tm-pub-status-col" aria-labelledby="tm-status-history">
              <h2 id="tm-status-history" className="tm-pub-eyebrow">
                {t('StatusScreen.earlierHeading')}
              </h2>
              <ol className="tm-pub-stack" aria-label={t('StatusScreen.earlierAria')}>
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
              {t('StatusScreen.lastIncidentHeading')}
            </h2>
            {latest ? (
              <IncidentCard incident={latest} level={3} />
            ) : (
              <p className="tm-pub-card tm-pub-card__body tm-pub-card--dashed">
                {t('StatusScreen.noIncidentsReported')}
              </p>
            )}
          </section>

          <section className="tm-pub-card tm-pub-card--roomy" aria-labelledby="tm-status-weeks">
            <h2 id="tm-status-weeks" className="tm-pub-eyebrow">
              {t('StatusScreen.last90Heading')}
            </h2>
            <ol className="tm-pub-bars" aria-label={t('StatusScreen.weeksAria')}>
              {weeks.map((week) => (
                <li
                  key={week.start}
                  className={week.incidents > 0 ? 'tm-pub-bars__bad' : undefined}
                  aria-label={`${t('StatusScreen.weekOf')}${formatDay(week.start)}: ${
                    week.incidents === 0
                      ? t('StatusScreen.noIncidentsShort')
                      : week.incidents === 1
                        ? t('StatusScreen.oneIncident')
                        : `${week.incidents} ${t('StatusScreen.incidentsCount')}`
                  }`}
                />
              ))}
            </ol>
            <p className="tm-pub-card__body">
              {weeks.some((week) => week.incidents > 0)
                ? t('StatusScreen.barsNoteSome')
                : t('StatusScreen.barsNoteNone')}
            </p>
          </section>
        </div>
      </div>
    </>
  );
}

function IncidentCard({ incident, level }: { incident: PublicIncidentView; level: 2 | 3 }) {
  const t = useT();
  const incidentLabels: Record<IncidentStatus, string> = {
    investigating: t('StatusScreen.incidentInvestigating'),
    identified: t('StatusScreen.incidentIdentified'),
    monitoring: t('StatusScreen.incidentMonitoring'),
    resolved: t('StatusScreen.incidentResolved'),
  };
  const stateLabel = incidentLabels[incident.status];
  const Heading = level === 2 ? 'h2' : 'h3';
  return (
    <article
      className={`tm-pub-card tm-pub-card--roomy tm-pub-incident tm-pub-incident--${
        incident.status === 'resolved' ? 'resolved' : 'open'
      }`}
    >
      <p className="tm-pub-card__eyebrow">
        {formatDay(parseTime(incident.startedAt) ?? 0)}
        {duration(incident, t)} · {stateLabel} · {incident.component}
      </p>
      <Heading className="tm-pub-card__title">{incident.title}</Heading>
      <p className="tm-pub-card__body">{incident.body}</p>
    </article>
  );
}

function summarise(recent: number, open: number, t: (key: MessageKey) => string): string {
  const opening =
    open === 0
      ? ''
      : open === 1
        ? t('StatusScreen.oneIncidentOpen')
        : `${open} ${t('StatusScreen.incidentsAreOpen')}`;
  if (recent === 0) return `${opening}${t('StatusScreen.noIncidents90')}`;
  if (recent === 1) return `${opening}${t('StatusScreen.oneIncident90')}`;
  return `${opening}${recent} ${t('StatusScreen.incidents90')}`;
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

function duration(incident: PublicIncidentView, t: (key: MessageKey) => string): string {
  const start = parseTime(incident.startedAt);
  const end = incident.resolvedAt === null ? null : parseTime(incident.resolvedAt);
  if (start === null || end === null || end < start) return '';
  const minutes = Math.round((end - start) / 60000);
  if (minutes < 60) return ` · ${minutes} ${t('StatusScreen.minUnit')}`;
  const hours = Math.round(minutes / 6) / 10;
  return ` · ${hours} ${t('StatusScreen.hourUnit')}`;
}

function parseTime(iso: string): number | null {
  const at = new Date(iso).getTime();
  return Number.isNaN(at) ? null : at;
}

function formatDay(at: number): string {
  return new Intl.DateTimeFormat(appLocale(), { day: 'numeric', month: 'short' }).format(at);
}

/** Format an ISO timestamp for display, following the browser's locale. */
function formatMoment(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso;
  return new Intl.DateTimeFormat(appLocale(), { dateStyle: 'medium', timeStyle: 'short' }).format(
    at,
  );
}
