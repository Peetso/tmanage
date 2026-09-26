'use client';

import { useQuery } from '@tanstack/react-query';
import { InlineAlert, LoadingRegion, Skeleton, StateCapsule } from '@tmanage/ui';
import type { CapsuleState } from '@tmanage/ui';
import { ClientPortalShell } from '../shell/ClientPortalShell';
import { browserApiClient } from '../../lib/api/browser-client';
import { listPortalMilestones, listPortalProjects } from '../../lib/api/portal';
import type { ClientMilestone, MilestoneStatus } from '../../lib/api/portal';
import { ApiRequestError, NetworkError } from '../../lib/api/errors';
import type { ApiClient } from '../../lib/api/client';

export interface PortalMilestonesScreenProps {
  organizationSlug: string;
  /** The client's own name leads the header. `22` §1. */
  clientName: string;
  providerName: string;
  client?: ApiClient;
}

/**
 * **Portal milestones (x139)** — the milestone half of the client portal's Timeline tab.
 *
 * The API returns only published milestones, ordered by target date, and the projection carries
 * no staff identity and no publish flag — so this screen renders what it is given without deciding
 * visibility. `12-PERMISSION-MATRIX` §4 gives the client "milestone state" and the committed date,
 * which is exactly `status` and `dueOn`; there is no internal task percentage and no owner, because
 * the shape it is handed has neither.
 *
 * The milestones are keyed on the first shared project, enabled only once that project id is known:
 * the endpoint names the project in the path, and there is nothing to ask for until the projects
 * list has answered. A 404 from the endpoint means "not your project", which cannot happen for the
 * client's own first project — an empty list is drawn as a sentence rather than a bare heading.
 */
export function PortalMilestonesScreen({
  organizationSlug,
  clientName,
  providerName,
  client,
}: PortalMilestonesScreenProps) {
  const api = client ?? browserApiClient();

  const projects = useQuery({
    queryKey: ['portal-projects', organizationSlug],
    queryFn: () => listPortalProjects(api, organizationSlug),
  });

  const project = projects.data?.[0];
  const projectId = project?.id;

  const milestones = useQuery({
    queryKey: ['portal-milestones', organizationSlug, projectId],
    queryFn: () => listPortalMilestones(api, organizationSlug, projectId!),
    enabled: projectId != null,
  });

  return (
    <ClientPortalShell
      organizationSlug={organizationSlug}
      clientName={clientName}
      providerName={providerName}
      {...(project ? { projectName: project.name } : {})}
      activeNavigationId="timeline"
      title="Timeline"
      description="Milestones for your project — when things are committed and how they are tracking."
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
        <MilestonesSection
          providerName={providerName}
          milestones={milestones.data ?? []}
          isPending={milestones.isPending && projectId != null}
          isError={milestones.isError}
          error={milestones.error}
          hasProject={projectId != null}
        />
      )}
    </ClientPortalShell>
  );
}

interface MilestonesSectionProps {
  providerName: string;
  milestones: readonly ClientMilestone[];
  isPending: boolean;
  isError: boolean;
  error: unknown;
  hasProject: boolean;
}

function MilestonesSection({
  providerName,
  milestones,
  isPending,
  isError,
  error,
  hasProject,
}: MilestonesSectionProps) {
  return (
    <section className="tm-panel tm-stack" aria-labelledby="tm-portal-milestones">
      <h2 id="tm-portal-milestones" className="tm-eyebrow">
        Milestones
      </h2>

      {!hasProject ? (
        <p className="tm-prose">
          There is no project shared with you yet. When {providerName} shares one, its milestones
          will appear here.
        </p>
      ) : isError ? (
        <InlineAlert tone="danger" title="Could not load milestones" live>
          {describe(error)}
        </InlineAlert>
      ) : isPending ? (
        <LoadingRegion label="Loading milestones">
          <Skeleton height="var(--row)" />
          <Skeleton height="var(--row)" />
        </LoadingRegion>
      ) : milestones.length === 0 ? (
        <p className="tm-prose">
          {providerName} has not published a milestone yet. When they set the dates for your
          project, they will appear here in order.
        </p>
      ) : (
        <ol className="tm-list tm-stack">
          {milestones.map((milestone) => (
            <li key={milestone.id} className="tm-stack tm-stack--tight">
              <div className="tm-row tm-row--wrap">
                <h3 className="tm-heading-3">{milestone.title}</h3>
                <StateCapsule state={capsuleState(milestone.status)} className="tm-push-end">
                  {statusLabel(milestone.status)}
                </StateCapsule>
              </div>
              <p className="tm-field__hint">{describeDue(milestone.dueOn)}</p>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

function statusLabel(status: MilestoneStatus): string {
  switch (status) {
    case 'met':
      return 'Met';
    case 'missed':
      return 'Missed';
    default:
      return 'Planned';
  }
}

function capsuleState(status: MilestoneStatus): CapsuleState {
  switch (status) {
    case 'met':
      return 'done';
    case 'missed':
      return 'blocked';
    default:
      return 'future';
  }
}

function describeDue(value: string | null): string {
  if (value === null) return 'No date committed yet';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return `Due ${value}`;
  return `Due ${new Intl.DateTimeFormat(undefined, { dateStyle: 'long' }).format(parsed)}`;
}

function describe(error: unknown): string {
  if (error instanceof ApiRequestError) return error.message;
  if (error instanceof NetworkError) return 'The portal is not answering. Try again shortly.';
  return 'Something went wrong. Try again.';
}
