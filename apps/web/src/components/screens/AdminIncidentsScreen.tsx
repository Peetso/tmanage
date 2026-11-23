'use client';

import { useQuery } from '@tanstack/react-query';
import { InlineAlert, LoadingRegion, Skeleton, StateCapsule } from '@tmanage/ui';
import { ControlCenterShell } from '../admin/ControlCenterShell';
import { browserApiClient } from '../../lib/api/browser-client';
import type { ApiClient } from '../../lib/api/client';
import { useDescribeApiError } from '../../lib/api/describe-error';
import {
  fetchWorkspaceIncidents,
  incidentCapsule,
  workspaceIncidentsKey,
} from '../../lib/api/incidents';
import type { IncidentStatus, WorkspaceIncidentView } from '../../lib/api/incidents';
import { useActiveLocale } from '../../lib/i18n/use-active-locale';
import { useTOr } from '../../lib/i18n/use-t-or';
import { withNumerals } from '../../lib/i18n/display-format';

export interface AdminIncidentsScreenProps {
  organizationSlug: string;
  organizationName: string;
  /** Injected in tests. Defaults to the browser client. */
  client?: ApiClient;
}

export const INCIDENT_STATUS_TEXT: Record<IncidentStatus, readonly [string, string]> = {
  investigating: ['Incidents.statusInvestigating', 'Investigating'],
  identified: ['Incidents.statusIdentified', 'Identified'],
  monitoring: ['Incidents.statusMonitoring', 'Monitoring'],
  resolved: ['Incidents.statusResolved', 'Resolved'],
};

/** "7 Nov, 09:12" in the reader's locale, or the raw value when unparseable. */
export function incidentMoment(iso: string, locale: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso;
  return new Intl.DateTimeFormat(withNumerals(locale), {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(at);
}

/**
 * A17 · **Incidents** (workspace owner) — Figma R31 L09 section, frames "Incidents · workspace ·
 * main / empty / AR". Problems on TManage that touch this workspace: everything published on the
 * status page, plus incidents announced to this workspace. The API (`org.manage`) decides what is
 * visible; this screen only draws it, newest first, with a capsule per status.
 */
export function AdminIncidentsScreen({
  organizationSlug,
  organizationName,
  client,
}: AdminIncidentsScreenProps) {
  const api = client ?? browserApiClient();
  const tOr = useTOr();
  const describe = useDescribeApiError();
  const locale = useActiveLocale();
  const incidents = useQuery({
    queryKey: workspaceIncidentsKey(organizationSlug),
    queryFn: () => fetchWorkspaceIncidents(api, organizationSlug),
    refetchInterval: 60_000,
  });
  const rows = incidents.data ?? [];

  return (
    <ControlCenterShell
      organizationSlug={organizationSlug}
      organizationName={organizationName}
      section="incidents"
      crumbs={[tOr('Incidents.crumbSecurity', 'Security'), tOr('Incidents.title', 'Incidents')]}
      title={tOr('Incidents.title', 'Incidents')}
      description={tOr(
        'Incidents.description',
        'Problems on TManage that touch your workspace, and what we are doing about them.',
      )}
    >
      {incidents.isPending ? (
        <LoadingRegion label={tOr('Incidents.loading', 'Loading incidents')} className="tm-stack">
          <Skeleton height="var(--row)" />
          <Skeleton height="var(--row)" />
        </LoadingRegion>
      ) : null}

      {incidents.isError ? (
        <InlineAlert
          tone="danger"
          title={tOr('Incidents.loadError', 'Incidents did not load')}
          live
        >
          {describe(incidents.error)}
        </InlineAlert>
      ) : null}

      {incidents.isSuccess ? (
        <section className="tm-cc-card tm-stack" aria-labelledby="tm-incidents-heading">
          <h2 id="tm-incidents-heading" className="tm-visually-hidden">
            {tOr('Incidents.title', 'Incidents')}
          </h2>
          {rows.length === 0 ? (
            <p className="tm-cc-note">
              {tOr(
                'Incidents.empty',
                'No incidents. Everything that touches your workspace is working normally.',
              )}
            </p>
          ) : (
            <ul className="tm-cc-rows">
              {rows.map((incident) => (
                <IncidentRow key={incident.id} incident={incident} locale={locale} />
              ))}
            </ul>
          )}
          <InlineAlert tone="neutral">
            {tOr(
              'Incidents.note',
              'We tell you here as soon as a problem touches your workspace. The public status page shows the rest.',
            )}
          </InlineAlert>
        </section>
      ) : null}
    </ControlCenterShell>
  );
}

function IncidentRow({ incident, locale }: { incident: WorkspaceIncidentView; locale: string }) {
  const tOr = useTOr();
  const [key, english] = INCIDENT_STATUS_TEXT[incident.status];
  const when =
    incident.resolvedAt === null
      ? `${tOr('Incidents.started', 'started')} ${incidentMoment(incident.startedAt, locale)}`
      : `${incidentMoment(incident.startedAt, locale)} – ${incidentMoment(incident.resolvedAt, locale)}`;
  return (
    <li>
      <div className="tm-cc-rows__text">
        <p className="tm-cc-rows__title">{incident.title}</p>
        <span className="tm-cc-rows__sub">
          <bdi>{incident.component}</bdi> · {when}
        </span>
        <span className="tm-cc-rows__sub">
          {incident.affectsWorkspace
            ? tOr('Incidents.affectsYou', 'Affects your workspace')
            : tOr('Incidents.allWorkspaces', 'All workspaces')}
        </span>
      </div>
      <StateCapsule state={incidentCapsule(incident.status)}>{tOr(key, english)}</StateCapsule>
    </li>
  );
}
