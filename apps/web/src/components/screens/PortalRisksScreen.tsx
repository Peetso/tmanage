'use client';

import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { InlineAlert, LoadingRegion, Skeleton } from '@tmanage/ui';
import { ClientPortalShell } from '../shell/ClientPortalShell';
import { browserApiClient } from '../../lib/api/browser-client';
import { listPortalProjects, listPortalRisks } from '../../lib/api/portal';
import type { ClientRisk, RiskSeverity, RiskStatus } from '../../lib/api/portal';
import { ApiRequestError, NetworkError } from '../../lib/api/errors';
import type { ApiClient } from '../../lib/api/client';
import { shortDay, Tag } from './PortalParts';
import { usePortalNames } from '../../lib/use-organization-names';

export interface PortalRisksScreenProps {
  organizationSlug: string;
  /** The client's own name leads the header. `22` §1. */
  clientName: string;
  providerName: string;
  client?: ApiClient;
}

/**
 * **Risks** — the risks the studio published to the client, in the handoff's portal language.
 *
 * `12-PERMISSION-MATRIX` §4 gives the client the "published risk" summary, its severity and its
 * status, which is exactly `clientSummary`, `severity` and `status`; there is no internal note and
 * no title. The design has no frame of its own for this destination — CL-04 carries risk in its
 * inverted "what would put the launch at risk" card — so the most serious open risk leads in that
 * card here, and every published risk follows as a capsule card.
 */
export function PortalRisksScreen({
  organizationSlug,
  clientName: passedClientName,
  providerName: passedProviderName,
  client,
}: PortalRisksScreenProps) {
  const { clientName, providerName } = usePortalNames(
    organizationSlug,
    passedClientName,
    passedProviderName,
  );
  const api = client ?? browserApiClient();

  const projects = useQuery({
    queryKey: ['portal-projects', organizationSlug],
    queryFn: () => listPortalProjects(api, organizationSlug),
  });

  const project = projects.data?.[0];
  const projectId = project?.id;

  const risks = useQuery({
    queryKey: ['portal-risks', organizationSlug, projectId],
    queryFn: () => listPortalRisks(api, organizationSlug, projectId!),
    enabled: projectId != null,
  });

  const rows = risks.data ?? [];
  const open = rows.filter((risk) => risk.status === 'open');

  return (
    <ClientPortalShell
      organizationSlug={organizationSlug}
      clientName={clientName}
      providerName={providerName}
      activeNavigationId="risks"
      title={
        risks.isSuccess
          ? open.length === 0
            ? 'Nothing threatens a date today'
            : open.length === 1
              ? 'One thing to keep an eye on'
              : `${open.length} things to keep an eye on`
          : 'Risks'
      }
      eyebrow={project ? `Risks · ${project.name}` : 'Risks'}
    >
      <div className="tm-pt tm-pt--compact">
        {projects.isError ? (
          <InlineAlert tone="danger" title="Could not load your portal" live>
            {describe(projects.error)}
          </InlineAlert>
        ) : null}

        {projects.isPending ? (
          <LoadingRegion label="Loading your project">
            <Skeleton height="var(--row)" />
            <Skeleton height="var(--row)" />
          </LoadingRegion>
        ) : (
          <RisksSection
            organizationSlug={organizationSlug}
            providerName={providerName}
            risks={rows}
            isPending={risks.isPending && projectId != null}
            isError={risks.isError}
            error={risks.error}
            hasProject={projectId != null}
          />
        )}
      </div>
    </ClientPortalShell>
  );
}

interface RisksSectionProps {
  organizationSlug: string;
  providerName: string;
  risks: readonly ClientRisk[];
  isPending: boolean;
  isError: boolean;
  error: unknown;
  hasProject: boolean;
}

function RisksSection({
  organizationSlug,
  providerName,
  risks,
  isPending,
  isError,
  error,
  hasProject,
}: RisksSectionProps) {
  if (!hasProject) {
    return (
      <p className="tm-pt-card tm-pt-card--dashed tm-pt-card__body">
        There is no project shared with you yet. When {providerName} shares one, anything that could
        affect it will appear here.
      </p>
    );
  }
  if (isError) {
    return (
      <InlineAlert tone="danger" title="Could not load risks" live>
        {describe(error)}
      </InlineAlert>
    );
  }
  if (isPending) {
    return (
      <LoadingRegion label="Loading risks">
        <Skeleton height="var(--row)" />
      </LoadingRegion>
    );
  }

  const ordered = [...risks].sort(
    (a, b) =>
      statusWeight(a.status) - statusWeight(b.status) || weight(b.severity) - weight(a.severity),
  );
  const lead = ordered.find((risk) => risk.status === 'open');

  return (
    <div className="tm-pt-split tm-pt-split--aside tm-pt-split--wide">
      <section className="tm-pt-col" aria-labelledby="tm-portal-risks">
        <h2 id="tm-portal-risks" className="tm-pt-eyebrow">
          Shared by {providerName} · {risks.length} {risks.length === 1 ? 'risk' : 'risks'}
        </h2>
        {risks.length === 0 ? (
          <p className="tm-pt-card tm-pt-card--dashed tm-pt-card__body">
            {providerName} has not flagged a risk on your project. If something could affect a date,
            it will appear here and they will tell you.
          </p>
        ) : (
          <ul className="tm-pt-list">
            {ordered.map((risk) => (
              <li
                key={risk.id}
                className={risk === lead ? 'tm-pt-action tm-pt-action--lead' : 'tm-pt-action'}
              >
                <span className="tm-pt-action__orb" aria-hidden="true">
                  {risk.status === 'open' ? '!' : '✓'}
                </span>
                <div className="tm-pt-action__body">
                  <div className="tm-pt-action__meta">
                    <Tag tone={severityTone(risk.severity)}>
                      {severityLabel(risk.severity)} severity
                    </Tag>
                    <Tag tone={risk.status === 'open' ? undefined : 'done'}>
                      {statusLabel(risk.status)}
                    </Tag>
                    <span className="tm-pt-mono">Shared {shortDay(risk.createdAt)}</span>
                  </div>
                  <p className="tm-pt-action__title">{risk.clientSummary}</p>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="tm-pt-ink tm-pt-ink--tall" aria-labelledby="tm-portal-risk-lead">
        <h2 id="tm-portal-risk-lead" className="tm-pt-eyebrow">
          What would put the launch at risk
        </h2>
        <p className="tm-pt-ink__title">{lead ? lead.clientSummary : 'Nothing today.'}</p>
        <p className="tm-pt-quiet">
          You would hear from {providerName} the same day if a date had to move.
        </p>
        <Link
          className="tm-pt-btn tm-pt-btn--lime tm-pt-ink__cta"
          href={`/${organizationSlug}/portal/timeline`}
        >
          See the timeline
        </Link>
      </section>
    </div>
  );
}

function weight(severity: RiskSeverity): number {
  return severity === 'high' ? 3 : severity === 'medium' ? 2 : 1;
}

function statusWeight(status: RiskStatus): number {
  return status === 'open' ? 0 : status === 'mitigated' ? 1 : 2;
}

function severityLabel(severity: RiskSeverity): string {
  switch (severity) {
    case 'high':
      return 'High';
    case 'low':
      return 'Low';
    default:
      return 'Medium';
  }
}

function severityTone(severity: RiskSeverity): 'danger' | 'warning' | undefined {
  switch (severity) {
    case 'high':
      return 'danger';
    case 'medium':
      return 'warning';
    default:
      return undefined;
  }
}

function statusLabel(status: RiskStatus): string {
  switch (status) {
    case 'mitigated':
      return 'Mitigated';
    case 'closed':
      return 'Closed';
    default:
      return 'Open';
  }
}

function describe(error: unknown): string {
  if (error instanceof ApiRequestError) return error.message;
  if (error instanceof NetworkError) return 'The portal is not answering. Try again shortly.';
  return 'Something went wrong. Try again.';
}
