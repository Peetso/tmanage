'use client';

import { useQuery } from '@tanstack/react-query';
import { InlineAlert, LoadingRegion, Skeleton, StateCapsule } from '@tmanage/ui';
import type { CapsuleState } from '@tmanage/ui';
import { ClientPortalShell } from '../shell/ClientPortalShell';
import { browserApiClient } from '../../lib/api/browser-client';
import { listPortalProjects, listPortalRisks } from '../../lib/api/portal';
import type { ClientRisk, RiskSeverity, RiskStatus } from '../../lib/api/portal';
import { ApiRequestError, NetworkError } from '../../lib/api/errors';
import type { ApiClient } from '../../lib/api/client';

export interface PortalRisksScreenProps {
  organizationSlug: string;
  /** The client's own name leads the header. `22` §1. */
  clientName: string;
  providerName: string;
  client?: ApiClient;
}

/**
 * **Portal risks (x140)** — the risks register on the client portal.
 *
 * The API returns only published risks, and the projection carries no title, no internal note and no
 * staff identity — so this screen renders what it is given without deciding visibility.
 * `12-PERMISSION-MATRIX` §4 gives the client the "published risk" summary, its severity and its
 * status, which is exactly `clientSummary`, `severity` and `status`; there is no internal note and no
 * owner, because the shape it is handed has neither.
 *
 * The risks are keyed on the first shared project, enabled only once that project id is known: the
 * endpoint names the project in the path, and there is nothing to ask for until the projects list has
 * answered. A 404 from the endpoint means "not your project", which cannot happen for the client's own
 * first project — an empty list is drawn as a sentence rather than a bare heading.
 */
export function PortalRisksScreen({
  organizationSlug,
  clientName,
  providerName,
  client,
}: PortalRisksScreenProps) {
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

  return (
    <ClientPortalShell
      organizationSlug={organizationSlug}
      clientName={clientName}
      providerName={providerName}
      {...(project ? { projectName: project.name } : {})}
      activeNavigationId="risks"
      title="Risks"
      description="Risks your team is tracking on your project — what they are and how they are being handled."
    >
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
          providerName={providerName}
          risks={risks.data ?? []}
          isPending={risks.isPending && projectId != null}
          isError={risks.isError}
          error={risks.error}
          hasProject={projectId != null}
        />
      )}
    </ClientPortalShell>
  );
}

interface RisksSectionProps {
  providerName: string;
  risks: readonly ClientRisk[];
  isPending: boolean;
  isError: boolean;
  error: unknown;
  hasProject: boolean;
}

function RisksSection({
  providerName,
  risks,
  isPending,
  isError,
  error,
  hasProject,
}: RisksSectionProps) {
  return (
    <section className="tm-panel tm-stack" aria-labelledby="tm-portal-risks">
      <h2 id="tm-portal-risks" className="tm-eyebrow">
        Risks
      </h2>

      {!hasProject ? (
        <p className="tm-prose">
          There is no project shared with you yet. When {providerName} shares one, any risks they
          are tracking will appear here.
        </p>
      ) : isError ? (
        <InlineAlert tone="danger" title="Could not load risks" live>
          {describe(error)}
        </InlineAlert>
      ) : isPending ? (
        <LoadingRegion label="Loading risks">
          <Skeleton height="var(--row)" />
          <Skeleton height="var(--row)" />
        </LoadingRegion>
      ) : risks.length === 0 ? (
        <p className="tm-prose">
          {providerName} has not published a risk for your project. When they are tracking something
          you should know about, it will appear here.
        </p>
      ) : (
        <ol className="tm-list tm-stack">
          {risks.map((risk) => (
            <li key={risk.id} className="tm-stack tm-stack--tight">
              <div className="tm-row tm-row--wrap">
                <StateCapsule state={severityCapsule(risk.severity)}>
                  {severityLabel(risk.severity)} severity
                </StateCapsule>
                <StateCapsule state={statusCapsule(risk.status)} className="tm-push-end">
                  {statusLabel(risk.status)}
                </StateCapsule>
              </div>
              <p className="tm-prose">{risk.clientSummary}</p>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
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

function severityCapsule(severity: RiskSeverity): CapsuleState {
  switch (severity) {
    case 'high':
      return 'blocked';
    case 'low':
      return 'neutral';
    default:
      return 'waiting';
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

function statusCapsule(status: RiskStatus): CapsuleState {
  switch (status) {
    case 'mitigated':
      return 'current';
    case 'closed':
      return 'done';
    default:
      return 'future';
  }
}

function describe(error: unknown): string {
  if (error instanceof ApiRequestError) return error.message;
  if (error instanceof NetworkError) return 'The portal is not answering. Try again shortly.';
  return 'Something went wrong. Try again.';
}
