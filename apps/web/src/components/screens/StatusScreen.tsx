'use client';

import { useQuery } from '@tanstack/react-query';
import { InlineAlert, LoadingRegion, Skeleton, StatusDot } from '@tmanage/ui';
import type { StatusTone } from '@tmanage/ui';
import { IdentityShell } from '../shell/IdentityShell';
import { browserApiClient } from '../../lib/api/browser-client';
import { fetchPublicStatus } from '../../lib/api/public-site';
import type { IncidentStatus, PublicIncidentView, PublicStatusView } from '../../lib/api/public-site';
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
 * The frame is `IdentityShell`: a standalone public page, like sign-in and recover, with no rail and
 * no tenant. The shell owns the skip link, the `<main>` and the live region; this screen owns the one
 * `<h1>` and the content, so A11Y-01's landmarks/heading/skip-link hold structurally.
 */
export function StatusScreen({ client }: StatusScreenProps) {
  const api = client ?? browserApiClient();

  const status = useQuery({
    queryKey: ['public-status'],
    queryFn: () => fetchPublicStatus(api),
  });

  return (
    <IdentityShell screenId="Trust" eyebrow="Service status">
      <h1 className="tm-identity__title">Service status</h1>

      {status.isPending ? (
        <LoadingRegion label="Loading the service status." className="tm-stack tm-stack--tight">
          <Skeleton height="var(--row)" />
          <Skeleton height="var(--row)" />
        </LoadingRegion>
      ) : null}

      {status.isError ? (
        <InlineAlert tone="danger" title="Could not load the status page" live>
          {describe(status.error)}
        </InlineAlert>
      ) : null}

      {status.isSuccess ? <StatusBody status={status.data} /> : null}
    </IdentityShell>
  );
}

function StatusBody({ status }: { status: PublicStatusView }) {
  const overall = OVERALL[status.overall];

  return (
    <div className="tm-stack">
      <p>
        <StatusDot tone={overall.tone}>{overall.label}</StatusDot>
      </p>

      {status.incidents.length === 0 ? (
        <InlineAlert tone="neutral">No incidents have been reported.</InlineAlert>
      ) : (
        <section className="tm-stack" aria-labelledby="tm-status-incidents">
          <h2 id="tm-status-incidents" className="tm-eyebrow">
            Recent incidents
          </h2>
          <ol className="tm-stack tm-stack--tight" aria-label="Incidents, newest first">
            {status.incidents.map((incident) => (
              <li key={incident.id}>
                <IncidentCard incident={incident} />
              </li>
            ))}
          </ol>
        </section>
      )}
    </div>
  );
}

function IncidentCard({ incident }: { incident: PublicIncidentView }) {
  const state = INCIDENT[incident.status];
  return (
    <article className="tm-panel tm-stack tm-stack--tight">
      <StatusDot tone={state.tone}>{state.label}</StatusDot>
      <h3>{incident.title}</h3>
      <p className="tm-mono">
        {incident.component} · started {formatMoment(incident.startedAt)}
        {incident.resolvedAt === null ? '' : ` · resolved ${formatMoment(incident.resolvedAt)}`}
      </p>
      <p>{incident.body}</p>
    </article>
  );
}

/** The overall banner's word and tone for each state. `operational` is the only success. */
const OVERALL: Record<PublicStatusView['overall'], { label: string; tone: StatusTone }> = {
  operational: { label: 'All systems operational', tone: 'success' },
  investigating: { label: 'Investigating an incident', tone: 'danger' },
  identified: { label: 'Issue identified', tone: 'warning' },
  monitoring: { label: 'Monitoring a fix', tone: 'live' },
};

/** Per-incident state word and tone. */
const INCIDENT: Record<IncidentStatus, { label: string; tone: StatusTone }> = {
  investigating: { label: 'Investigating', tone: 'danger' },
  identified: { label: 'Identified', tone: 'warning' },
  monitoring: { label: 'Monitoring', tone: 'live' },
  resolved: { label: 'Resolved', tone: 'success' },
};

/** Turn a thrown value into a sentence a person can act on. Never leaks a stack or a cause. */
function describe(error: unknown): string {
  if (error instanceof ApiRequestError) return error.message;
  if (error instanceof NetworkError) return 'The status service did not answer. Try again shortly.';
  return 'Something went wrong. Try again.';
}

/** Format an ISO timestamp for display, following the browser's locale. */
function formatMoment(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso;
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(at);
}
