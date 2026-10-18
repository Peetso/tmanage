'use client';

import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { InlineAlert, LoadingRegion, Skeleton } from '@tmanage/ui';
import { ClientPortalShell } from '../shell/ClientPortalShell';
import { browserApiClient } from '../../lib/api/browser-client';
import { listPortalMilestones, listPortalProjects, listPortalUpdates } from '../../lib/api/portal';
import type { ClientMilestone, PortalProject } from '../../lib/api/portal';
import { ApiRequestError, NetworkError } from '../../lib/api/errors';
import type { ApiClient } from '../../lib/api/client';
import { longDay, shortDay, Tag } from './PortalParts';
import { usePortalNames } from '../../lib/use-organization-names';

export interface PortalUpdatesScreenProps {
  organizationSlug: string;
  /** The client's own name leads the header. `22` §1. */
  clientName: string;
  providerName: string;
  client?: ApiClient;
}

/**
 * **CL-11 Updates** — written narrative, not an activity log.
 *
 * The updates the studio wrote and published on the client's first shared project (CL-03's
 * `listPortalUpdates`; the API returns only `published` rows, newest first). Drawn as the
 * handoff's CL-11: the newest update in an ink-outlined card with the rest beneath it, and on the
 * right the inverted "where the project stands" card with the agreed date and estimate, then the
 * dates still ahead from the published milestones.
 *
 * The notification feed (`NOTIF-001`) is a different thing and lives at `/portal/inbox`; this
 * destination is the studio's own words.
 */
export function PortalUpdatesScreen({
  organizationSlug,
  clientName: passedClientName,
  providerName: passedProviderName,
  client,
}: PortalUpdatesScreenProps) {
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

  const updates = useQuery({
    queryKey: ['portal-updates', organizationSlug, projectId],
    queryFn: () => listPortalUpdates(api, organizationSlug, projectId!),
    enabled: projectId != null,
  });

  const milestones = useQuery({
    queryKey: ['portal-milestones', organizationSlug, projectId],
    queryFn: () => listPortalMilestones(api, organizationSlug, projectId!),
    enabled: projectId != null,
  });

  const rows = updates.data ?? [];

  return (
    <ClientPortalShell
      organizationSlug={organizationSlug}
      clientName={clientName}
      providerName={providerName}
      activeNavigationId="updates"
      title="Every update, in plain words"
      eyebrow={`Updates · written by ${providerName}`}
    >
      <div className="tm-pt tm-pt--compact">
        {projects.isError || updates.isError ? (
          <InlineAlert tone="danger" title="Could not load updates" live>
            {describe(projects.error ?? updates.error)}
          </InlineAlert>
        ) : null}

        {projects.isPending || (updates.isPending && projectId != null) ? (
          <LoadingRegion label="Loading updates.">
            <Skeleton height="var(--row)" />
            <Skeleton height="var(--row)" />
          </LoadingRegion>
        ) : null}

        <div className="tm-pt-split tm-pt-split--aside">
          <section className="tm-pt-col" aria-label={`Updates from ${providerName}`}>
            {!projects.isPending && project == null ? (
              <p className="tm-pt-card tm-pt-card--dashed tm-pt-card__body">
                There is no project shared with you yet. When {providerName} shares one, their
                updates will appear here.
              </p>
            ) : null}

            {updates.isSuccess && rows.length === 0 ? (
              <p className="tm-pt-card tm-pt-card--dashed tm-pt-card__body">
                {providerName} has not posted an update yet. When they share news about your
                project, it will appear here, newest first.
              </p>
            ) : null}

            {rows.length > 0 ? (
              <ol className="tm-pt-list">
                {rows.map((update, index) => (
                  <li
                    key={update.id}
                    className={
                      index === 0
                        ? 'tm-pt-card tm-pt-card--lg tm-pt-card--lead tm-pt-update'
                        : 'tm-pt-card tm-pt-card--lg tm-pt-update'
                    }
                  >
                    <div className="tm-pt-action__meta">
                      {index === 0 ? <Tag tone="lime">Latest</Tag> : null}
                      <time className="tm-pt-mono" dateTime={update.createdAt}>
                        {weekday(update.createdAt)} · {providerName}
                      </time>
                    </div>
                    <h2
                      className={index === 0 ? 'tm-pt-update__title--lead' : 'tm-pt-update__title'}
                    >
                      {update.title}
                    </h2>
                    <p className="tm-pt-update__body">{update.body}</p>
                    {index === 0 ? (
                      <div className="tm-pt-form__actions">
                        <Link
                          className="tm-pt-btn tm-pt-btn--lime"
                          href={`/${organizationSlug}/portal/actions`}
                        >
                          See what needs you
                        </Link>
                        <Link
                          className="tm-pt-btn"
                          href={`/${organizationSlug}/portal/requests/new`}
                        >
                          Ask a question
                        </Link>
                      </div>
                    ) : null}
                  </li>
                ))}
              </ol>
            ) : null}
          </section>

          {project ? (
            <div className="tm-pt-col">
              <ProjectStands project={project} />
              <ComingUp milestones={milestones.data ?? []} />
            </div>
          ) : null}
        </div>
      </div>
    </ClientPortalShell>
  );
}

function ProjectStands({ project }: { project: PortalProject }) {
  return (
    <section className="tm-pt-ink" aria-labelledby="tm-updates-stands">
      <h2 id="tm-updates-stands" className="tm-pt-eyebrow">
        Where the project stands
      </h2>
      <p className="tm-pt-ink__big">
        {project.committedAt ? shortDay(project.committedAt) : 'No date yet'}
      </p>
      <p className="tm-pt-quiet">
        {project.committedAt ? 'the date agreed with you' : 'no date has been agreed yet'}
      </p>
      <hr className="tm-pt-ink__rule" />
      <p className="tm-pt-ink__big tm-pt-ink__big--lime">
        {project.forecastAt ? shortDay(project.forecastAt) : '—'}
      </p>
      <p className="tm-pt-quiet">
        {project.forecastAt
          ? 'the current estimate, which can move'
          : 'no estimate has been shared yet'}
      </p>
    </section>
  );
}

function ComingUp({ milestones }: { milestones: readonly ClientMilestone[] }) {
  const ahead = milestones
    .filter((milestone) => milestone.status !== 'met')
    .sort((a, b) => (a.dueOn ?? '9999').localeCompare(b.dueOn ?? '9999'))
    .slice(0, 3);
  if (ahead.length === 0) return null;
  return (
    <section className="tm-pt-card" aria-labelledby="tm-updates-dates">
      <h2 id="tm-updates-dates" className="tm-pt-eyebrow">
        Dates ahead
      </h2>
      <ul className="tm-pt-rows">
        {ahead.map((milestone) => (
          <li key={milestone.id}>
            <div className="tm-pt-item__main">
              <p className="tm-pt-rows__title">{milestone.title}</p>
              <p className="tm-pt-quiet">
                {milestone.dueOn
                  ? `${milestone.status === 'missed' ? 'was due' : 'committed'} ${longDay(milestone.dueOn)}`
                  : 'no date yet'}
              </p>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

function weekday(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return new Intl.DateTimeFormat('en-GB', {
    weekday: 'long',
    day: 'numeric',
    month: 'short',
  }).format(parsed);
}

function describe(error: unknown): string {
  if (error instanceof ApiRequestError) return error.message;
  if (error instanceof NetworkError) return 'The portal is not answering. Try again shortly.';
  return 'Something went wrong. Try again.';
}
